import { AxiomClient, FriendsClient } from './client';
import { WS_ENDPOINTS, RoomPrefixes } from './types';
import * as fs from 'fs';
import * as path from 'path';

// Token to watch
const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';
const NUM_INSTANCES = parseInt(process.argv[3] || '5', 10);

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

interface ViewerInstance {
  id: number;
  cluster: AxiomClient;
  eucalyptus: AxiomClient;
  friends: FriendsClient;
}

async function createViewer(id: number, cookies: string): Promise<ViewerInstance> {
  const cluster = new AxiomClient({ wsUrl: WS_ENDPOINTS.CLUSTER }, cookies);
  const eucalyptus = new AxiomClient({ wsUrl: WS_ENDPOINTS.EUCALYPTUS }, cookies);
  const friends = new FriendsClient(cookies);

  cluster.on('connected', () => {
    console.log(`[Viewer ${id}] Cluster connected`);
    cluster.subscribeToToken(TOKEN);
  });

  eucalyptus.on('connected', () => {
    console.log(`[Viewer ${id}] Eucalyptus connected`);
    eucalyptus.joinRoom(`${RoomPrefixes.EYES}${TOKEN}`);
  });

  eucalyptus.on('message', (msg: { room?: string; content?: string }) => {
    if (msg.room?.startsWith('e-')) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [Viewer ${id}] 👁 Viewers: ${msg.content}`);
    }
  });

  friends.on('connected', () => {
    console.log(`[Viewer ${id}] Friends connected`);
  });

  // Suppress verbose logging
  cluster.on('error', () => {});
  eucalyptus.on('error', () => {});
  friends.on('error', () => {});

  return { id, cluster, eucalyptus, friends };
}

async function main() {
  console.log('=== Axiom Multi-Viewer Test ===\n');
  console.log(`Token: ${TOKEN}`);
  console.log(`Instances: ${NUM_INSTANCES}\n`);

  const cookies = loadCookies();
  if (!cookies) {
    console.error('No cookies found. Run "npm run login" first.');
    process.exit(1);
  }

  const viewers: ViewerInstance[] = [];

  // Create viewers sequentially with small delay
  for (let i = 1; i <= NUM_INSTANCES; i++) {
    console.log(`Creating viewer ${i}...`);
    const viewer = await createViewer(i, cookies);
    viewers.push(viewer);

    // Connect all three for each viewer
    await Promise.all([
      viewer.cluster.connect().catch(e => console.error(`[Viewer ${i}] Cluster error:`, e.message)),
      viewer.eucalyptus.connect().catch(e => console.error(`[Viewer ${i}] Eucalyptus error:`, e.message)),
      viewer.friends.connect().catch(e => console.error(`[Viewer ${i}] Friends error:`, e.message)),
    ]);

    // Small delay between creating viewers
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`\n✅ ${viewers.length} viewers connected!\n`);
  console.log('Monitoring viewer count... (Ctrl+C to exit)\n');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down all viewers...');
    for (const viewer of viewers) {
      viewer.cluster.disconnect();
      viewer.eucalyptus.disconnect();
      viewer.friends.disconnect();
    }
    process.exit(0);
  });
}

main().catch(console.error);
