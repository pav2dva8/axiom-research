/**
 * Viewer Navigation Test
 *
 * Tests the theory that viewer count is registered when you:
 * 1. Leave the previous token room
 * 2. Join the new token room
 *
 * This simulates what happens during client-side navigation.
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.error('No .env file');
    process.exit(1);
  }

  const envContent = fs.readFileSync(envPath, 'utf-8');
  const cookieMatch = envContent.match(/AXIOM_COOKIES=(.+)/);
  const userIdMatch = envContent.match(/AXIOM_USER_ID=([^\s]+)/);

  let userId = '';
  if (userIdMatch) {
    userId = userIdMatch[1].trim();
  } else {
    const accessTokenMatch = envContent.match(/AXIOM_ACCESS_TOKEN=([^\s]+)/);
    if (accessTokenMatch) {
      const payload = accessTokenMatch[1].split('.')[1];
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
      userId = decoded.authenticatedUserId;
    }
  }

  return { cookies: cookieMatch?.[1].trim() || '', userId };
}

async function main() {
  console.log('=== Viewer Navigation Test ===\n');
  console.log(`Token: ${TOKEN}\n`);

  const { cookies, userId } = loadEnv();
  console.log(`User ID: ${userId}\n`);

  // Connect to eucalyptus with user-id
  const wsUrl = `wss://eucalyptus.axiom.trade/ws?user-id=${userId}`;
  console.log(`Connecting to: ${wsUrl}\n`);

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

    // Simulate navigation sequence:
    // 1. First, leave any previous room (simulate being on another page)
    // 2. Then join the target token room

    const viewerRoom = `e-${TOKEN}`;

    console.log('=== Simulating Navigation ===\n');

    // Step 1: Leave a "previous" room (as if we were on another token page)
    const fakeOldRoom = `e-FAKE_OLD_TOKEN_ADDRESS`;
    console.log(`[1] Leaving old room: ${fakeOldRoom}`);
    ws.send(JSON.stringify({ action: 'leave', room: fakeOldRoom }));

    await new Promise(r => setTimeout(r, 500));

    // Step 2: Join the new room
    console.log(`[2] Joining new room: ${viewerRoom}`);
    ws.send(JSON.stringify({ action: 'join', room: viewerRoom }));

    await new Promise(r => setTimeout(r, 500));

    // Step 3: Try alternate message formats
    console.log(`[3] Trying subscribe format`);
    ws.send(JSON.stringify({ action: 'subscribe', room: viewerRoom }));

    await new Promise(r => setTimeout(r, 500));

    // Step 4: Try with token directly
    console.log(`[4] Trying view action`);
    ws.send(JSON.stringify({ action: 'view', token: TOKEN }));

    await new Promise(r => setTimeout(r, 500));

    // Step 5: Try enter action
    console.log(`[5] Trying enter action`);
    ws.send(JSON.stringify({ action: 'enter', room: viewerRoom }));

    console.log('\n=== Waiting for responses ===\n');
  });

  ws.on('message', (data) => {
    const msg = data.toString();
    if (msg !== '{"method":"pong"}') {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] RECV:`, msg);
    }
  });

  ws.on('error', (err) => console.error('Error:', err.message));
  ws.on('close', () => console.log('Connection closed'));

  process.on('SIGINT', () => {
    ws.close();
    process.exit(0);
  });
}

main().catch(console.error);
