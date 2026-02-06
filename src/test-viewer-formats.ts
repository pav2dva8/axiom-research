/**
 * Test different viewer registration message formats
 *
 * Tries various WebSocket message formats to find what
 * actually registers a viewer on eucalyptus.
 */

import WebSocket from 'ws';
import { getOrCreateWallet, signup, type AuthTokens } from './auth';
import * as fs from 'fs';
import * as path from 'path';

const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';

function extractUserId(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
  return decoded.authenticatedUserId;
}

async function getAccount(): Promise<{ tokens: AuthTokens; userId: string }> {
  const walletsDir = path.join(process.cwd(), 'wallets');
  const walletPath = path.join(walletsDir, 'wallet_test.json');
  const tokensPath = path.join(walletsDir, 'tokens_test.json');

  if (!fs.existsSync(walletsDir)) {
    fs.mkdirSync(walletsDir, { recursive: true });
  }

  let tokens: AuthTokens;
  if (fs.existsSync(tokensPath)) {
    tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
  } else {
    const wallet = getOrCreateWallet(walletPath);
    tokens = await signup(wallet);
    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
  }

  const userId = extractUserId(tokens.accessToken);
  return { tokens, userId };
}

async function testFormats(userId: string, cookies: string) {
  const wsUrl = `wss://eucalyptus.axiom.trade/ws?user-id=${userId}`;
  console.log(`Connecting: ${wsUrl}\n`);

  const ws = new WebSocket(wsUrl, {
    headers: {
      'Origin': 'https://axiom.trade',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Cookie': cookies,
    }
  });

  const room = `e-${TOKEN}`;

  ws.on('open', async () => {
    console.log('Connected!\n');

    // Test different message formats
    const formats = [
      // Standard join
      { action: 'join', room },
      // Subscribe format
      { action: 'subscribe', room },
      { action: 'subscribe', channel: room },
      // Enter/view format
      { action: 'enter', room },
      { action: 'view', room },
      { action: 'watch', room },
      // With token directly
      { action: 'join', token: TOKEN },
      { action: 'view', token: TOKEN },
      { action: 'watch', token: TOKEN },
      // Register format
      { action: 'register', room },
      { action: 'register', token: TOKEN },
      // Method-based
      { method: 'join', room },
      { method: 'subscribe', room },
      { method: 'view', room },
      // Type-based
      { type: 'join', room },
      { type: 'subscribe', room },
      { type: 'view', room },
      // Event-based
      { event: 'join', room },
      { event: 'subscribe', data: { room } },
      // With chain
      { action: 'join', room, chain: 'sol' },
      { action: 'view', room, chain: 'sol' },
      // SOL prefix
      { action: 'join', room: `sol-${TOKEN}` },
      // Presence format
      { action: 'presence', room },
      { presence: { room, status: 'online' } },
      // Track format
      { action: 'track', room },
      { action: 'track', token: TOKEN },
    ];

    for (let i = 0; i < formats.length; i++) {
      const msg = formats[i];
      console.log(`[${i + 1}/${formats.length}] Sending:`, JSON.stringify(msg));
      ws.send(JSON.stringify(msg));
      await new Promise(r => setTimeout(r, 500));
    }

    console.log('\n=== All formats sent ===');
    console.log('Check browser for viewer count change.');
    console.log('Keeping connection alive...\n');

    // Keep alive
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, 30000);
  });

  ws.on('message', (data) => {
    const msg = data.toString();
    if (msg !== '{"method":"pong"}') {
      console.log('RECV:', msg.slice(0, 200));
    }
  });

  ws.on('error', (err) => console.error('Error:', err.message));
  ws.on('close', () => console.log('Disconnected'));

  process.on('SIGINT', () => {
    ws.close();
    process.exit(0);
  });
}

async function main() {
  console.log('=== Test Viewer Registration Formats ===');
  console.log(`Token: ${TOKEN}\n`);

  const { tokens, userId } = await getAccount();
  console.log(`User ID: ${userId}\n`);

  await testFormats(userId, tokens.cookies);
}

main().catch(console.error);
