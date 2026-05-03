/**
 * Axiom Viewer Bot
 *
 * Increases viewer count on a token by sending pageUpdate messages
 * to the friends server from multiple accounts.
 *
 * Usage: npx tsx src/viewer-bot.ts <pairAddress> <numViewers>
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { getOrCreateWallet, signup, type AuthTokens } from './auth';

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

interface Account {
  id: number;
  cookies: string;
  ws?: WebSocket;
}

const PAIR_ADDRESS = process.argv[2];
const NUM_VIEWERS = parseInt(process.argv[3] || '10', 10);

if (!PAIR_ADDRESS) {
  console.error('Usage: npx tsx src/viewer-bot.ts <pairAddress> [numViewers]');
  console.error('Example: npx tsx src/viewer-bot.ts 6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG 10');
  process.exit(1);
}

async function fetchTokenInfo(pairAddress: string): Promise<TokenInfo | null> {
  try {
    // Fetch token info from Axiom API
    const response = await fetch(`https://api2.axiom.trade/pair-info?pairAddress=${pairAddress}&v=${Date.now()}`, {
      headers: {
        'Origin': 'https://axiom.trade',
        'Referer': 'https://axiom.trade/',
      }
    });

    if (!response.ok) {
      console.error('Failed to fetch token info:', response.status);
      return null;
    }

    const data = await response.json() as any;

    return {
      pairAddress: pairAddress,
      tokenAddress: data.tokenAddress || data.baseToken?.address || '',
      ticker: data.ticker || data.baseToken?.symbol || 'UNKNOWN',
      name: data.name || data.baseToken?.name || 'Unknown Token',
      protocol: data.protocol || 'Pump V1',
      isMigrated: data.isMigrated || false,
      supply: data.supply || data.baseToken?.totalSupply || 1000000000,
      price: data.price || data.priceUsd || 0
    };
  } catch (err: any) {
    console.error('Error fetching token info:', err.message);
    return null;
  }
}

async function loadOrCreateAccount(id: number): Promise<Account | null> {
  const walletsDir = path.join(process.cwd(), 'wallets');
  if (!fs.existsSync(walletsDir)) {
    fs.mkdirSync(walletsDir, { recursive: true });
  }

  const tokensPath = path.join(walletsDir, `tokens_${id}.json`);
  const walletPath = path.join(walletsDir, `wallet_${id}.json`);

  let tokens: AuthTokens;

  if (fs.existsSync(tokensPath)) {
    tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
  } else {
    console.log(`[Account ${id}] Creating new account...`);
    try {
      const wallet = getOrCreateWallet(walletPath);
      tokens = await signup(wallet);
      fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
      console.log(`[Account ${id}] Account created!`);
    } catch (err: any) {
      console.error(`[Account ${id}] Failed to create:`, err.message);
      return null;
    }
  }

  return { id, cookies: tokens.cookies };
}

function connectViewer(account: Account, tokenInfo: TokenInfo): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://friends.axiom.trade/ws', {
      headers: {
        'Origin': 'https://axiom.trade',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Cookie': account.cookies,
      }
    });

    const timeout = setTimeout(() => {
      reject(new Error('Connection timeout'));
    }, 10000);

    ws.on('open', () => {
      clearTimeout(timeout);

      // Start ping every second
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('.');
        } else {
          clearInterval(pingInterval);
        }
      }, 1000);

      // Send pageUpdate
      const pageUpdate = {
        type: 'pageUpdate',
        page: 'meme',
        subpage: tokenInfo,
        chain: 'sol'
      };
      ws.send(JSON.stringify(pageUpdate));

      account.ws = ws;
      resolve(ws);
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('close', () => {
      // Will be handled by main loop
    });
  });
}

async function main() {
  console.log('=== Axiom Viewer Bot ===\n');
  console.log(`Pair Address: ${PAIR_ADDRESS}`);
  console.log(`Target Viewers: ${NUM_VIEWERS}\n`);

  // Fetch token info
  console.log('Fetching token info...');
  const tokenInfo = await fetchTokenInfo(PAIR_ADDRESS);

  if (!tokenInfo) {
    // Use minimal info if API fails
    console.log('Using minimal token info...');
  }

  const finalTokenInfo: TokenInfo = tokenInfo || {
    pairAddress: PAIR_ADDRESS,
    tokenAddress: '',
    ticker: 'TOKEN',
    name: 'Token',
    protocol: 'Pump V1',
    isMigrated: false,
    supply: 1000000000,
    price: 0
  };

  console.log(`Token: ${finalTokenInfo.ticker} (${finalTokenInfo.name})\n`);

  // Load or create accounts
  const accounts: Account[] = [];

  for (let i = 1; i <= NUM_VIEWERS; i++) {
    const account = await loadOrCreateAccount(i);
    if (account) {
      accounts.push(account);
    }

    // Rate limit account creation
    if (i < NUM_VIEWERS) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\nLoaded ${accounts.length} accounts\n`);

  if (accounts.length === 0) {
    console.error('No accounts available');
    process.exit(1);
  }

  // Connect all viewers
  console.log('Connecting viewers...\n');
  let connected = 0;

  for (const account of accounts) {
    try {
      await connectViewer(account, finalTokenInfo);
      connected++;
      process.stdout.write(`\rConnected: ${connected}/${accounts.length}`);
    } catch (err: any) {
      // Silent fail, continue with others
    }

    // Small delay between connections
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n\n✅ ${connected} viewers active on ${finalTokenInfo.ticker}`);
  console.log('\nPress Ctrl+C to stop\n');

  // Keep running
  process.on('SIGINT', () => {
    console.log('\nStopping viewers...');
    for (const account of accounts) {
      if (account.ws) {
        account.ws.close();
      }
    }
    process.exit(0);
  });

  // Periodically log status
  setInterval(() => {
    const active = accounts.filter(a => a.ws?.readyState === WebSocket.OPEN).length;
    console.log(`[Status] ${active} viewers active`);
  }, 30000);
}

main().catch(console.error);
