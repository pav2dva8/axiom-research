import { AxiomClient, FriendsClient } from './client';
import { WS_ENDPOINTS, RoomPrefixes } from './types';
import { getOrCreateWallet, signup, WalletInfo, AuthTokens } from './auth';
import * as fs from 'fs';
import * as path from 'path';

// Token to watch
const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';
const NUM_ACCOUNTS = parseInt(process.argv[3] || '3', 10);

interface ViewerAccount {
  id: number;
  wallet: WalletInfo;
  tokens: AuthTokens;
  userId: string;
  cluster: AxiomClient;
  eucalyptus: AxiomClient;
  friends: FriendsClient;
}

function extractUserId(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
  return decoded.authenticatedUserId;
}

async function createAccount(id: number): Promise<ViewerAccount | null> {
  const walletPath = path.join(process.cwd(), `wallets/wallet_${id}.json`);

  // Ensure wallets directory exists
  const walletsDir = path.join(process.cwd(), 'wallets');
  if (!fs.existsSync(walletsDir)) {
    fs.mkdirSync(walletsDir, { recursive: true });
  }

  console.log(`[Account ${id}] Creating wallet...`);
  const wallet = getOrCreateWallet(walletPath);

  // Check if we already have tokens for this wallet
  const tokensPath = path.join(process.cwd(), `wallets/tokens_${id}.json`);
  let tokens: AuthTokens;

  if (fs.existsSync(tokensPath)) {
    console.log(`[Account ${id}] Loading existing tokens...`);
    tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
  } else {
    console.log(`[Account ${id}] Signing up...`);
    try {
      tokens = await signup(wallet);
      fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
      console.log(`[Account ${id}] Signup successful!`);
    } catch (error: any) {
      console.error(`[Account ${id}] Signup failed:`, error.message);
      return null;
    }
  }

  // Extract userId from access token
  const userId = extractUserId(tokens.accessToken);
  console.log(`[Account ${id}] User ID: ${userId}`);

  // Create clients - eucalyptus needs userId for viewer count
  const cluster = new AxiomClient({ wsUrl: WS_ENDPOINTS.CLUSTER }, tokens.cookies);
  const eucalyptus = new AxiomClient({ wsUrl: WS_ENDPOINTS.EUCALYPTUS }, tokens.cookies, userId);
  const friends = new FriendsClient(tokens.cookies);

  return { id, wallet, tokens, userId, cluster, eucalyptus, friends };
}

async function connectViewer(account: ViewerAccount): Promise<boolean> {
  const { id, cluster, eucalyptus, friends } = account;

  return new Promise(async (resolve) => {
    let connected = 0;
    const checkDone = () => {
      connected++;
      if (connected >= 3) {
        console.log(`[Account ${id}] All connections established!`);
        resolve(true);
      }
    };

    cluster.on('connected', () => {
      console.log(`[Account ${id}] Cluster connected`);
      cluster.subscribeToToken(TOKEN);
      checkDone();
    });

    eucalyptus.on('connected', () => {
      console.log(`[Account ${id}] Eucalyptus connected`);
      eucalyptus.joinRoom(`${RoomPrefixes.EYES}${TOKEN}`);
      checkDone();
    });

    eucalyptus.on('message', (msg: { room?: string; content?: string }) => {
      if (msg.room?.startsWith('e-')) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[${timestamp}] [Account ${id}] 👁 Viewers: ${msg.content}`);
      }
    });

    friends.on('connected', () => {
      console.log(`[Account ${id}] Friends connected`);
      checkDone();
    });

    // Suppress verbose errors
    cluster.on('error', () => {});
    eucalyptus.on('error', () => {});
    friends.on('error', () => {});

    try {
      await Promise.all([
        cluster.connect().catch(e => console.error(`[Account ${id}] Cluster error:`, e.message)),
        eucalyptus.connect().catch(e => console.error(`[Account ${id}] Eucalyptus error:`, e.message)),
        friends.connect().catch(e => console.error(`[Account ${id}] Friends error:`, e.message)),
      ]);
    } catch (err) {
      console.error(`[Account ${id}] Connection failed`);
      resolve(false);
    }
  });
}

async function main() {
  console.log('=== Axiom Multi-Account Viewer Test ===\n');
  console.log(`Token: ${TOKEN}`);
  console.log(`Creating ${NUM_ACCOUNTS} accounts...\n`);

  const accounts: ViewerAccount[] = [];

  // Create accounts sequentially (to avoid rate limiting)
  for (let i = 1; i <= NUM_ACCOUNTS; i++) {
    const account = await createAccount(i);
    if (account) {
      accounts.push(account);
    }
    // Delay between signups to avoid rate limiting
    if (i < NUM_ACCOUNTS) {
      console.log('Waiting 2s before next account...\n');
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n✅ Created ${accounts.length} accounts\n`);

  if (accounts.length === 0) {
    console.error('No accounts created, exiting');
    process.exit(1);
  }

  // Connect all accounts
  console.log('Connecting all accounts...\n');
  for (const account of accounts) {
    await connectViewer(account);
    await new Promise(r => setTimeout(r, 500)); // Small delay between connections
  }

  console.log(`\n✅ ${accounts.length} viewers connected!\n`);
  console.log('Monitoring viewer count... (Ctrl+C to exit)\n');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down all accounts...');
    for (const account of accounts) {
      account.cluster.disconnect();
      account.eucalyptus.disconnect();
      account.friends.disconnect();
    }
    process.exit(0);
  });
}

main().catch(console.error);
