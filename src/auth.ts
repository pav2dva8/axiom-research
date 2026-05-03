import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import * as fs from 'fs';
import * as path from 'path';
import nodeFetch, { RequestInit } from 'node-fetch';
import { AbortController } from 'abort-controller';


const API_BASE = 'https://api2.axiom.trade';
const FETCH_TIMEOUT = 15000; // 15 seconds timeout
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const fetchWithTimeout = (url: string, options?: RequestInit) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  const headers: Record<string, string> = {
    'User-Agent': BROWSER_USER_AGENT,
    ...(options?.headers as Record<string, string> || {}),
  };

  return nodeFetch(url, {
    ...options,
    headers,
    signal: controller.signal as any,
  } as any).finally(() => clearTimeout(timeout));
};

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  cookies: string;
}

export interface WalletInfo {
  publicKey: string;
  secretKey: Uint8Array;
  keypair: Keypair;
}

/**
 * Generate a new Solana wallet or load from file
 */
export function getOrCreateWallet(walletPath?: string): WalletInfo {
  const filePath = walletPath || path.join(process.cwd(), 'wallet.json');

  // Try to load existing wallet
  if (fs.existsSync(filePath)) {
    console.log('[Auth] Loading existing wallet from', filePath);
    const walletData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const secretKey = Uint8Array.from(walletData.secretKey);
    const keypair = Keypair.fromSecretKey(secretKey);
    return {
      publicKey: keypair.publicKey.toBase58(),
      secretKey,
      keypair,
    };
  }

  // Generate new wallet
  console.log('[Auth] Generating new Solana wallet...');
  const keypair = Keypair.generate();
  const walletInfo: WalletInfo = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: keypair.secretKey,
    keypair,
  };

  // Save wallet for future use
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      publicKey: walletInfo.publicKey,
      secretKey: Array.from(walletInfo.secretKey),
    }, null, 2)
  );
  console.log('[Auth] Wallet saved to', filePath);
  console.log('[Auth] Public key:', walletInfo.publicKey);

  return walletInfo;
}

/**
 * Load wallet from private key (base58 encoded)
 */
export function loadWalletFromPrivateKey(privateKeyBase58: string): WalletInfo {
  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  return {
    publicKey: keypair.publicKey.toBase58(),
    secretKey,
    keypair,
  };
}

/**
 * Step 1: Get nonce from Axiom API
 */
export async function getNonce(walletAddress: string, cfCookies?: string): Promise<string> {
  console.log('[Auth] Requesting nonce for wallet:', walletAddress);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Origin': 'https://axiom.trade',
    'Referer': 'https://axiom.trade/',
  };
  if (cfCookies) {
    headers['Cookie'] = cfCookies;
  }

  const response = await fetchWithTimeout(`${API_BASE}/wallet-nonce`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      walletAddress,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get nonce: ${response.status} ${response.statusText}`);
  }

  // API returns nonce as plain text, not JSON
  const nonce = await response.text();
  console.log('[Auth] Received nonce:', nonce);
  return nonce;
}

/**
 * Step 2: Sign the nonce message with wallet
 */
export function signMessage(message: string, secretKey: Uint8Array): string {
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, secretKey);
  const signatureBase58 = bs58.encode(signature);
  console.log('[Auth] Message signed');
  return signatureBase58;
}

/**
 * Build the message to sign (matching Axiom's format)
 */
export function buildSignMessage(nonce: string): string {
  // Based on the Phantom popup, the message format is:
  // "By signing, you agree to Axiom's Terms of Use & Privacy Policy (axiom.trade/legal).\n\nNonce: {nonce}"
  return `By signing, you agree to Axiom's Terms of Use & Privacy Policy (axiom.trade/legal).\n\nNonce: ${nonce}`;
}

/**
 * Step 3: Verify wallet with signature
 */
export async function verifyWallet(
  walletAddress: string,
  nonce: string,
  signature: string,
  allowRegistration: boolean = false,
  turnstileToken?: string,
  cfCookies?: string,
): Promise<AuthTokens> {
  console.log(`[Auth] Verifying wallet (${allowRegistration ? 'signup' : 'login'})...`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Origin': 'https://axiom.trade',
    'Referer': 'https://axiom.trade/',
  };
  if (cfCookies) {
    headers['Cookie'] = cfCookies;
  }

  const response = await fetchWithTimeout(`${API_BASE}/verify-wallet-v2`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      walletAddress,
      allowLinking: false,
      allowRegistration,
      forAddCredential: false,
      isVerify: false,
      nonce,
      referrer: null,
      signature,
      turnstileToken: turnstileToken || null,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to verify wallet: ${response.status} ${response.statusText} - ${errorText}`);
  }

  // Extract cookies from response (node-fetch uses raw() method)
  const setCookieHeaders = (response.headers as any).raw?.()?.['set-cookie'] || (response.headers as any).getSetCookie?.() || [];
  console.log('[Auth] Set-Cookie headers:', setCookieHeaders.length);

  let accessToken = '';
  let refreshToken = '';
  const cookieParts: string[] = [];

  for (const cookie of setCookieHeaders) {
    const match = cookie.match(/^([^=]+)=([^;]+)/);
    if (match) {
      const [, name, value] = match;
      cookieParts.push(`${name}=${value}`);

      if (name === 'auth-access-token') {
        accessToken = value;
      } else if (name === 'auth-refresh-token') {
        refreshToken = value;
      }
    }
  }

  const cookies = cookieParts.join('; ');
  console.log('[Auth] Authentication successful!');
  console.log('[Auth] Access token:', accessToken.slice(0, 20) + '...');

  return {
    accessToken,
    refreshToken,
    cookies,
  };
}

async function authenticate(
  wallet: WalletInfo,
  allowRegistration: boolean,
  cfCookies?: string,
  turnstileToken?: string,
): Promise<AuthTokens> {
  const nonce = await getNonce(wallet.publicKey, cfCookies);
  const message = buildSignMessage(nonce);
  const signature = signMessage(message, wallet.secretKey);
  return verifyWallet(
    wallet.publicKey, nonce, signature, allowRegistration, turnstileToken, cfCookies,
  );
}

/**
 * Login with existing Axiom account
 */
export async function login(
  wallet: WalletInfo,
  cfCookies?: string,
  turnstileToken?: string,
): Promise<AuthTokens> {
  console.log('[Auth] Logging in with existing account...');
  return authenticate(wallet, false, cfCookies, turnstileToken);
}

/**
 * Signup for new Axiom account
 */
export async function signup(
  wallet: WalletInfo,
  cfCookies?: string,
  turnstileToken?: string,
): Promise<AuthTokens> {
  console.log('[Auth] Signing up for new account...');
  return authenticate(wallet, true, cfCookies, turnstileToken);
}

/**
 * Save tokens to .env file
 */
export function saveTokensToEnv(tokens: AuthTokens, envPath?: string): void {
  const filePath = envPath || path.join(process.cwd(), '.env');
  const content = `AXIOM_COOKIES=${tokens.cookies}\nAXIOM_ACCESS_TOKEN=${tokens.accessToken}\nAXIOM_REFRESH_TOKEN=${tokens.refreshToken}\n`;
  fs.writeFileSync(filePath, content);
  console.log('[Auth] Tokens saved to', filePath);
}
