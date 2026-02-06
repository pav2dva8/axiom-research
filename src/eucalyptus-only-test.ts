/**
 * Eucalyptus-Only Viewer Test
 *
 * Connects multiple accounts to eucalyptus ONLY (no cluster/friends)
 * to test if different user-ids increase the viewer count.
 */

import WebSocket from 'ws';
import { getOrCreateWallet, signup, type AuthTokens } from './auth';
import * as fs from 'fs';
import * as path from 'path';

const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';
const NUM_ACCOUNTS = parseInt(process.argv[3] || '3', 10);

function extractUserId(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
  return decoded.authenticatedUserId;
}

async function createOrLoadAccount(index: number): Promise<{ tokens: AuthTokens; userId: string }> {
  const walletsDir = path.join(process.cwd(), 'wallets');
  if (!fs.existsSync(walletsDir)) {
    fs.mkdirSync(walletsDir, { recursive: true });
  }

  const walletPath = path.join(walletsDir, `wallet_${index}.json`);
  const tokensPath = path.join(walletsDir, `tokens_${index}.json`);

  let tokens: AuthTokens;

  if (fs.existsSync(tokensPath)) {
    console.log(`[Account ${index}] Loading existing tokens...`);
    tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
  } else {
    console.log(`[Account ${index}] Creating new account...`);
    const wallet = getOrCreateWallet(walletPath);
    tokens = await signup(wallet);
    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
  }

  const userId = extractUserId(tokens.accessToken);
  console.log(`[Account ${index}] User ID: ${userId}`);

  return { tokens, userId };
}

function connectEucalyptus(userId: string, cookies: string, index: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = `wss://eucalyptus.axiom.trade/ws?user-id=${userId}`;
    console.log(`[Viewer ${index}] Connecting: ${wsUrl.slice(0, 60)}...`);

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Origin': 'https://axiom.trade',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Cookie': cookies,
      }
    });

    const timeout = setTimeout(() => {
      reject(new Error('Connection timeout'));
    }, 10000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log(`[Viewer ${index}] Connected!`);

      // Start ping
      setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'ping' }));
        }
      }, 30000);

      // Join the token room
      const room = `e-${TOKEN}`;
      console.log(`[Viewer ${index}] Joining room: ${room}`);
      ws.send(JSON.stringify({ action: 'join', room }));

      resolve(ws);
    });

    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg !== '{"method":"pong"}') {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.room?.startsWith('e-') && parsed.content) {
            console.log(`[Viewer ${index}] 👁 Viewer count: ${parsed.content}`);
          } else {
            console.log(`[Viewer ${index}] Message:`, msg.slice(0, 100));
          }
        } catch {
          console.log(`[Viewer ${index}] Raw:`, msg.slice(0, 100));
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[Viewer ${index}] Error:`, err.message);
      reject(err);
    });

    ws.on('close', () => {
      console.log(`[Viewer ${index}] Disconnected`);
    });
  });
}

async function main() {
  console.log('=== Eucalyptus-Only Viewer Test ===');
  console.log(`Token: ${TOKEN}`);
  console.log(`Accounts: ${NUM_ACCOUNTS}\n`);

  const accounts: { tokens: AuthTokens; userId: string }[] = [];
  const connections: WebSocket[] = [];

  // Create/load accounts
  for (let i = 1; i <= NUM_ACCOUNTS; i++) {
    try {
      const account = await createOrLoadAccount(i);
      accounts.push(account);
      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      console.error(`Failed to create account ${i}:`, err.message);
    }
  }

  console.log(`\n=== ${accounts.length} accounts ready ===\n`);

  // Connect all accounts to eucalyptus
  for (let i = 0; i < accounts.length; i++) {
    try {
      const ws = await connectEucalyptus(accounts[i].userId, accounts[i].tokens.cookies, i + 1);
      connections.push(ws);
      console.log(`[Viewer ${i + 1}] Waiting 2 seconds before next connection...\n`);
      await new Promise(r => setTimeout(r, 2000));
    } catch (err: any) {
      console.error(`Failed to connect viewer ${i + 1}:`, err.message);
    }
  }

  console.log(`\n=== ${connections.length} viewers connected ===`);
  console.log('Check browser for viewer count. Press Ctrl+C to exit.\n');

  process.on('SIGINT', () => {
    console.log('\nClosing all connections...');
    connections.forEach(ws => ws.close());
    process.exit(0);
  });
}

main().catch(console.error);
