import { AxiomClient } from './client';
import { RoomPrefixes } from './types';

// Example token address from the URL you shared
const EXAMPLE_TOKEN = '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';

async function main() {
  const client = new AxiomClient({
    // You can try different clusters: cluster1, cluster2, ..., cluster9
    wsUrl: 'wss://cluster9.axiom.trade/',
  });

  // Event handlers
  client.on('connected', () => {
    console.log('\n=== Connected to Axiom ===\n');

    // Subscribe to global data
    client.subscribeToPrices();
    client.subscribeToMigrations();
    client.subscribeToFees();

    // Subscribe to a specific token
    console.log(`\nSubscribing to token: ${EXAMPLE_TOKEN}\n`);
    client.subscribeToToken(EXAMPLE_TOKEN);
  });

  client.on('disconnected', (code: number, reason: string) => {
    console.log(`\n=== Disconnected: ${code} - ${reason} ===\n`);
  });

  client.on('error', (error: Error) => {
    console.error('WebSocket error:', error.message);
  });

  // Handle all incoming messages
  client.on('message', (message: unknown) => {
    const msg = message as Record<string, unknown>;
    const timestamp = new Date().toISOString();

    // Pretty print based on message type
    if (msg.room === 'sol_price' || msg.room === 'btc_price') {
      console.log(`[${timestamp}] PRICE | ${msg.room}: ${JSON.stringify(msg.data || msg)}`);
    } else if (msg.room?.toString().startsWith(RoomPrefixes.SUBSCRIBERS)) {
      console.log(`[${timestamp}] VIEWERS | ${JSON.stringify(msg)}`);
    } else if (msg.room === 'migrations' || msg.room === 'migration-heaven') {
      console.log(`[${timestamp}] MIGRATION | ${JSON.stringify(msg)}`);
    } else if (msg.room?.toString().startsWith(RoomPrefixes.FEED)) {
      console.log(`[${timestamp}] TRADE | ${JSON.stringify(msg)}`);
    } else if (msg.room?.toString().startsWith(RoomPrefixes.TOKEN)) {
      console.log(`[${timestamp}] TOKEN | ${JSON.stringify(msg)}`);
    } else if (msg.method === 'pong') {
      // Ignore pong responses
    } else {
      console.log(`[${timestamp}] MSG | ${JSON.stringify(msg)}`);
    }
  });

  // Connect
  try {
    await client.connect();
  } catch (error) {
    console.error('Failed to connect:', error);
    process.exit(1);
  }

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    client.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    client.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
