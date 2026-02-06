/**
 * Test Cluster-based Viewer Registration
 *
 * Hypothesis: The viewer count is actually registered through
 * the cluster WebSocket, not eucalyptus.
 * Eucalyptus might just broadcast the count.
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';

function loadAccount(id: number): { cookies: string; userId: string } | null {
  const tokensPath = path.join(process.cwd(), `wallets/tokens_${id}.json`);
  if (fs.existsSync(tokensPath)) {
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
    const payload = tokens.accessToken.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    return { cookies: tokens.cookies, userId: decoded.authenticatedUserId };
  }
  return null;
}

async function connectAll(userId: string, cookies: string, label: string) {
  console.log(`\n=== ${label}: Connecting to all servers ===\n`);

  const servers = [
    { name: 'cluster', url: 'wss://cluster8.axiom.trade/' },
    { name: 'eucalyptus', url: `wss://eucalyptus.axiom.trade/ws?user-id=${userId}` },
    { name: 'friends', url: 'wss://friends.axiom.trade/ws' },
  ];

  const connections: WebSocket[] = [];

  for (const server of servers) {
    const ws = new WebSocket(server.url, {
      headers: {
        'Origin': 'https://axiom.trade',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Cookie': cookies,
      }
    });

    ws.on('open', () => {
      console.log(`[${label}] ${server.name}: Connected`);

      // Start appropriate ping
      if (server.name === 'friends') {
        setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('.'), 1000);
      } else {
        setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ method: 'ping' })), 30000);
      }

      // Join rooms based on server type
      if (server.name === 'cluster') {
        // Join all token-related rooms
        const rooms = [
          `t:${TOKEN}`,      // Token data
          `f:${TOKEN}`,      // Feed
          `td:${TOKEN}`,     // Token details
          `s:${TOKEN}`,      // Subscribers
          `e:${TOKEN}`,      // Events
          `e-${TOKEN}`,      // Eyes (viewer count) - try on cluster too
        ];
        rooms.forEach(room => {
          console.log(`[${label}] cluster: Joining ${room}`);
          ws.send(JSON.stringify({ action: 'join', room }));
        });
      } else if (server.name === 'eucalyptus') {
        console.log(`[${label}] eucalyptus: Joining e-${TOKEN}`);
        ws.send(JSON.stringify({ action: 'join', room: `e-${TOKEN}` }));
      }
    });

    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg !== '{"method":"pong"}' && msg !== '.') {
        // Check for viewer count messages
        try {
          const parsed = JSON.parse(msg);
          if (parsed.room?.startsWith('e-') || parsed.room?.startsWith('e:')) {
            console.log(`[${label}] ${server.name}: 👁 ${msg.slice(0, 100)}`);
          }
        } catch {}
      }
    });

    ws.on('error', (err) => {
      console.log(`[${label}] ${server.name}: Error - ${err.message}`);
    });

    connections.push(ws);
  }

  return connections;
}

async function main() {
  console.log('=== Test Cluster-based Viewer Registration ===');
  console.log(`Token: ${TOKEN}\n`);

  // Load multiple accounts
  const accounts = [];
  for (let i = 1; i <= 3; i++) {
    const acc = loadAccount(i);
    if (acc) {
      accounts.push({ id: i, ...acc });
      console.log(`Account ${i}: ${acc.userId}`);
    }
  }

  if (accounts.length === 0) {
    console.error('No accounts found');
    return;
  }

  // Connect first account to all servers
  const allConnections: WebSocket[][] = [];

  for (const acc of accounts) {
    const conns = await connectAll(acc.userId, acc.cookies, `Acc${acc.id}`);
    allConnections.push(conns);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n=== ${accounts.length} accounts connected to all servers ===`);
  console.log('Check browser for viewer count.\n');
  console.log('Press Ctrl+C to exit.\n');

  process.on('SIGINT', () => {
    console.log('\nClosing all connections...');
    allConnections.flat().forEach(ws => ws.close());
    process.exit(0);
  });
}

main().catch(console.error);
