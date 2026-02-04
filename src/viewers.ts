import { AxiomClient } from './client';
import { WS_ENDPOINTS } from './types';
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
  console.log(`WebSocket: ${WS_ENDPOINTS.CLUSTER}\n`);

  const cookies = loadCookies();
  if (!cookies) {
    console.warn('[Warning] No cookies found. Run "npm run login" first.\n');
  }

  // Connect to cluster server (viewer count works on clusters too)
  const client = new AxiomClient({
    wsUrl: WS_ENDPOINTS.CLUSTER,
  }, cookies);

  client.on('connected', () => {
    console.log('Connected to Axiom!\n');

    // Subscribe to ALL token rooms (like browser does)
    // This might be required to count as a "viewer"
    client.subscribeToToken(TOKEN);

    // Also subscribe to viewer count room
    client.subscribeToViewerCount(TOKEN);
  });

  client.on('message', (msg: { room?: string; content?: string }) => {
    if (msg.room?.startsWith('e-')) {
      const viewerCount = msg.content;
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] 👁 Viewers: ${viewerCount}`);
    }
  });

  client.on('error', (err: Error) => {
    console.error('Error:', err.message);
  });

  try {
    await client.connect();
  } catch (err) {
    console.error('Failed to connect:', err);
    process.exit(1);
  }

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    client.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
