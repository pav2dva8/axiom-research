/**
 * Viewer PageUpdate Test
 *
 * The viewer count is registered via pageUpdate message to friends.axiom.trade
 *
 * Message format:
 * {
 *   "type": "pageUpdate",
 *   "page": "meme",
 *   "subpage": {
 *     "pairAddress": "...",
 *     "tokenAddress": "...",
 *     "ticker": "...",
 *     "name": "...",
 *     "protocol": "Pump V1",
 *     "isMigrated": false,
 *     "supply": 1000000000,
 *     "price": ...
 *   },
 *   "chain": "sol"
 * }
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

const TOKEN_ADDRESS = process.argv[2] || '3Aw9TYCEFVLZ2My4MpEd7A6jmASdf2fCDLKhigLwpump';
const PAIR_ADDRESS = process.argv[3] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';

interface TokenInfo {
  pairAddress: string;
  tokenAddress: string;
  ticker: string;
  name: string;
  protocol: string;
  isMigrated: boolean;
  supply: number;
  price: number;
}

function loadAccount(id: number): { cookies: string } | null {
  const tokensPath = path.join(process.cwd(), `wallets/tokens_${id}.json`);
  if (fs.existsSync(tokensPath)) {
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
    return { cookies: tokens.cookies };
  }
  return null;
}

async function sendPageUpdate(cookies: string, tokenInfo: TokenInfo, label: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://friends.axiom.trade/ws', {
      headers: {
        'Origin': 'https://axiom.trade',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Cookie': cookies,
      }
    });

    ws.on('open', () => {
      console.log(`[${label}] Connected to friends server`);

      // Start ping (friends server uses "." as ping every second)
      setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('.');
        }
      }, 1000);

      // Send pageUpdate message
      const pageUpdate = {
        type: 'pageUpdate',
        page: 'meme',
        subpage: tokenInfo,
        chain: 'sol'
      };

      console.log(`[${label}] Sending pageUpdate:`, JSON.stringify(pageUpdate).slice(0, 100) + '...');
      ws.send(JSON.stringify(pageUpdate));

      resolve(ws);
    });

    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg !== '.' && msg.length < 500) {
        console.log(`[${label}] Received:`, msg);
      }
    });

    ws.on('error', (err) => {
      console.error(`[${label}] Error:`, err.message);
      reject(err);
    });

    ws.on('close', () => {
      console.log(`[${label}] Disconnected`);
    });
  });
}

async function main() {
  console.log('=== Viewer PageUpdate Test ===\n');
  console.log(`Token: ${TOKEN_ADDRESS}`);
  console.log(`Pair: ${PAIR_ADDRESS}\n`);

  const tokenInfo: TokenInfo = {
    pairAddress: PAIR_ADDRESS,
    tokenAddress: TOKEN_ADDRESS,
    ticker: 'Airdrop',
    name: 'Pumpfun Airdrop',
    protocol: 'Pump V1',
    isMigrated: false,
    supply: 1000000000,
    price: 0.00000002796
  };

  // Load multiple accounts
  const connections: WebSocket[] = [];

  for (let i = 1; i <= 5; i++) {
    const account = loadAccount(i);
    if (account) {
      try {
        const ws = await sendPageUpdate(account.cookies, tokenInfo, `Acc${i}`);
        connections.push(ws);
        console.log(`[Acc${i}] PageUpdate sent!\n`);
        await new Promise(r => setTimeout(r, 1000));
      } catch (err: any) {
        console.error(`[Acc${i}] Failed:`, err.message);
      }
    } else {
      console.log(`[Acc${i}] No tokens found, skipping`);
    }
  }

  console.log(`\n=== ${connections.length} accounts connected ===`);
  console.log('Check browser for viewer count change.');
  console.log('Press Ctrl+C to exit.\n');

  process.on('SIGINT', () => {
    console.log('\nClosing connections...');
    connections.forEach(ws => ws.close());
    process.exit(0);
  });
}

main().catch(console.error);
