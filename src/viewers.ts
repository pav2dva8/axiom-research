import { AxiomClient, FriendsClient } from './client';
import { WS_ENDPOINTS, RoomPrefixes } from './types';
import * as fs from 'fs';
import * as path from 'path';

// Token to watch
const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';

function loadCookies(): string {
  if (process.env.AXIOM_COOKIES) {
    return process.env.AXIOM_COOKIES;
  }
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/AXIOM_COOKIES=(.+)/);
    if (match) return match[1].trim();
  }
  return '';
}

async function main() {
  console.log('=== Axiom Viewer Count Monitor ===\n');
  console.log(`Token: ${TOKEN}`);

  const cookies = loadCookies();
  if (!cookies) {
    console.warn('[Warning] No cookies found. Run "npm run login" first.\n');
  }

  // Connect to ALL THREE servers like the browser does:
  // 1. Cluster - main trading data
  // 2. Eucalyptus - viewer count
  // 3. Friends - social/presence (may be required for viewer counting)
  console.log(`Connecting to cluster: ${WS_ENDPOINTS.CLUSTER}`);
  console.log(`Connecting to eucalyptus: ${WS_ENDPOINTS.EUCALYPTUS}`);
  console.log(`Connecting to friends: ${WS_ENDPOINTS.FRIENDS}\n`);

  // Cluster client for token data
  const clusterClient = new AxiomClient({
    wsUrl: WS_ENDPOINTS.CLUSTER,
  }, cookies);

  // Eucalyptus client for viewer count
  const eucalyptusClient = new AxiomClient({
    wsUrl: WS_ENDPOINTS.EUCALYPTUS,
  }, cookies);

  // Friends client for presence/social (may register as viewer)
  const friendsClient = new FriendsClient(cookies);

  clusterClient.on('connected', () => {
    console.log('[Cluster] Connected!');

    // Subscribe to ALL token rooms (like browser does)
    // This might be required to count as a "viewer"
    clusterClient.subscribeToToken(TOKEN);
  });

  clusterClient.on('message', (msg: { room?: string; content?: unknown }) => {
    // Log some key messages
    if (msg.room?.startsWith('t:')) {
      console.log(`[Cluster] Token update received`);
    }
  });

  clusterClient.on('error', (err: Error) => {
    console.error('[Cluster] Error:', err.message);
  });

  eucalyptusClient.on('connected', () => {
    console.log('[Eucalyptus] Connected!');

    // Subscribe to viewer count room
    const viewerRoom = `${RoomPrefixes.EYES}${TOKEN}`;
    console.log(`[Eucalyptus] Joining room: ${viewerRoom}`);
    eucalyptusClient.joinRoom(viewerRoom);
  });

  eucalyptusClient.on('message', (msg: { room?: string; content?: string }) => {
    if (msg.room?.startsWith('e-')) {
      const viewerCount = msg.content;
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] 👁 Viewers: ${viewerCount}`);
    } else {
      // Log all messages to understand the protocol
      console.log('[Eucalyptus] Message:', JSON.stringify(msg).slice(0, 200));
    }
  });

  eucalyptusClient.on('error', (err: Error) => {
    console.error('[Eucalyptus] Error:', err.message);
  });

  friendsClient.on('connected', () => {
    console.log('[Friends] Connected! (pinging every 1s)');
  });

  friendsClient.on('message', (msg: string) => {
    // Friends server may send presence updates
    if (msg && msg !== '.') {
      console.log('[Friends] Message:', msg.slice(0, 200));
    }
  });

  friendsClient.on('error', (err: Error) => {
    console.error('[Friends] Error:', err.message);
  });

  // Connect to all three
  try {
    await Promise.all([
      clusterClient.connect().catch(e => console.error('[Cluster] Failed:', e.message)),
      eucalyptusClient.connect().catch(e => console.error('[Eucalyptus] Failed:', e.message)),
      friendsClient.connect().catch(e => console.error('[Friends] Failed:', e.message)),
    ]);
  } catch (err) {
    console.error('Failed to connect:', err);
  }

  // Keep running
  console.log('\nMonitoring viewer count... (Ctrl+C to exit)\n');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    clusterClient.disconnect();
    eucalyptusClient.disconnect();
    friendsClient.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
