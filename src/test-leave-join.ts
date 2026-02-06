/**
 * Test Leave-then-Join viewer registration
 *
 * Hypothesis: The viewer count increments when you:
 * 1. Leave the old token room
 * 2. Join the new token room
 *
 * This simulates what happens during SPA navigation.
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';
// A different token to simulate "coming from another page"
const PREV_TOKEN = process.argv[3] || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC

function loadEnv(): { cookies: string; userId: string } {
  const tokensPath = path.join(process.cwd(), 'wallets/tokens_1.json');
  if (fs.existsSync(tokensPath)) {
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
    const payload = tokens.accessToken.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    return { cookies: tokens.cookies, userId: decoded.authenticatedUserId };
  }
  throw new Error('No tokens found');
}

async function main() {
  console.log('=== Test Leave-then-Join Viewer Registration ===\n');
  console.log(`Target Token: ${TOKEN}`);
  console.log(`Previous Token: ${PREV_TOKEN}\n`);

  const { cookies, userId } = loadEnv();
  console.log(`User ID: ${userId}\n`);

  const wsUrl = `wss://eucalyptus.axiom.trade/ws?user-id=${userId}`;
  console.log(`Connecting: ${wsUrl}\n`);

  const ws = new WebSocket(wsUrl, {
    headers: {
      'Origin': 'https://axiom.trade',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Cookie': cookies,
    }
  });

  ws.on('open', async () => {
    console.log('Connected!\n');

    // Start ping
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, 30000);

    const prevRoom = `e-${PREV_TOKEN}`;
    const targetRoom = `e-${TOKEN}`;

    // Simulate being on the previous token page first
    console.log('=== Phase 1: Simulate being on previous token page ===\n');
    console.log(`[1] Joining previous room: ${prevRoom}`);
    ws.send(JSON.stringify({ action: 'join', room: prevRoom }));

    await new Promise(r => setTimeout(r, 2000));

    // Now simulate navigation to the target token
    console.log('\n=== Phase 2: Simulate navigation to target token ===\n');

    // First leave the previous room
    console.log(`[2] Leaving previous room: ${prevRoom}`);
    ws.send(JSON.stringify({ action: 'leave', room: prevRoom }));

    await new Promise(r => setTimeout(r, 500));

    // Then join the new room
    console.log(`[3] Joining target room: ${targetRoom}`);
    ws.send(JSON.stringify({ action: 'join', room: targetRoom }));

    console.log('\n=== Navigation simulated ===');
    console.log('Check browser for viewer count change.');
    console.log('\nWaiting 10 seconds then will try again...\n');

    // Try again after a delay
    await new Promise(r => setTimeout(r, 10000));

    console.log('=== Phase 3: Second navigation attempt ===\n');

    // Leave target, join prev, then leave prev, join target again
    console.log(`[4] Leaving target room`);
    ws.send(JSON.stringify({ action: 'leave', room: targetRoom }));
    await new Promise(r => setTimeout(r, 500));

    console.log(`[5] Joining different room`);
    ws.send(JSON.stringify({ action: 'join', room: prevRoom }));
    await new Promise(r => setTimeout(r, 2000));

    console.log(`[6] Leaving different room`);
    ws.send(JSON.stringify({ action: 'leave', room: prevRoom }));
    await new Promise(r => setTimeout(r, 500));

    console.log(`[7] Re-joining target room`);
    ws.send(JSON.stringify({ action: 'join', room: targetRoom }));

    console.log('\n=== Second navigation complete ===');
    console.log('Keeping connection alive. Press Ctrl+C to exit.\n');
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

main().catch(console.error);
