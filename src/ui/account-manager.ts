/**
 * Account Manager
 *
 * Handles creation, storage, and loading of Axiom accounts
 */

import * as fs from 'fs';
import * as path from 'path';
import { Keypair } from '@solana/web3.js';
import { login, type AuthTokens, type WalletInfo } from '../auth';
import type { BrowserSession } from '../browser-auth';

export interface StoredAccount {
  id: number;
  publicKey: string;
  createdAt: string;
  lastUsed?: string;
}

export interface LoadedAccount {
  id: number;
  publicKey: string;
  cookies: string;
  accessToken: string;
  refreshToken: string;
}

const ACCOUNTS_DIR = path.join(process.cwd(), 'accounts');
const ACCOUNTS_INDEX = path.join(ACCOUNTS_DIR, 'index.json');

export class AccountManager {
  private accounts: StoredAccount[] = [];

  constructor() {
    this.ensureDir();
    this.loadIndex();
  }

  private ensureDir(): void {
    if (!fs.existsSync(ACCOUNTS_DIR)) {
      fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    }
  }

  private loadIndex(): void {
    if (fs.existsSync(ACCOUNTS_INDEX)) {
      try {
        this.accounts = JSON.parse(fs.readFileSync(ACCOUNTS_INDEX, 'utf-8'));
      } catch {
        this.accounts = [];
      }
    }
  }

  private saveIndex(): void {
    fs.writeFileSync(ACCOUNTS_INDEX, JSON.stringify(this.accounts, null, 2));
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  listAccounts(): StoredAccount[] {
    return [...this.accounts];
  }

  loadAccount(id: number): LoadedAccount | null {
    const tokensPath = path.join(ACCOUNTS_DIR, `tokens_${id}.json`);
    const walletPath = path.join(ACCOUNTS_DIR, `wallet_${id}.json`);

    if (!fs.existsSync(tokensPath) || !fs.existsSync(walletPath)) {
      return null;
    }

    try {
      const tokens: AuthTokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
      const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));

      // Update last used
      const accountIndex = this.accounts.findIndex(a => a.id === id);
      if (accountIndex >= 0) {
        this.accounts[accountIndex].lastUsed = new Date().toISOString();
        this.saveIndex();
      }

      return {
        id,
        publicKey: wallet.publicKey,
        cookies: tokens.cookies,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    } catch {
      return null;
    }
  }

  loadAccounts(ids: number[]): LoadedAccount[] {
    const loaded: LoadedAccount[] = [];
    for (const id of ids) {
      const account = this.loadAccount(id);
      if (account) {
        loaded.push(account);
      }
    }
    return loaded;
  }

  loadAllAccounts(): LoadedAccount[] {
    return this.loadAccounts(this.accounts.map(a => a.id));
  }

  deleteAccount(id: number): boolean {
    const tokensPath = path.join(ACCOUNTS_DIR, `tokens_${id}.json`);
    const walletPath = path.join(ACCOUNTS_DIR, `wallet_${id}.json`);

    try {
      if (fs.existsSync(tokensPath)) fs.unlinkSync(tokensPath);
      if (fs.existsSync(walletPath)) fs.unlinkSync(walletPath);

      this.accounts = this.accounts.filter(a => a.id !== id);
      this.saveIndex();
      return true;
    } catch {
      return false;
    }
  }

  deleteAllAccounts(): void {
    for (const account of this.accounts) {
      this.deleteAccount(account.id);
    }
    this.accounts = [];
    this.saveIndex();
  }

  /**
   * Re-login an account using its wallet (when tokens expired)
   */
  async reloginAccount(id: number, browserSession?: BrowserSession): Promise<boolean> {
    const walletPath = path.join(ACCOUNTS_DIR, `wallet_${id}.json`);
    const tokensPath = path.join(ACCOUNTS_DIR, `tokens_${id}.json`);

    if (!fs.existsSync(walletPath)) {
      console.error(`[AccountManager] Wallet not found for account ${id}`);
      return false;
    }

    try {
      // Load wallet
      const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
      const secretKey = Uint8Array.from(walletData.secretKey);
      const keypair = Keypair.fromSecretKey(secretKey);

      const wallet: WalletInfo = {
        publicKey: keypair.publicKey.toBase58(),
        secretKey,
        keypair,
      };

      // Re-login: use browser session if available (handles CF + Turnstile), else try direct
      console.log(`[AccountManager] Re-logging in account ${id}...`);
      const tokens = browserSession
        ? await browserSession.loginAccount(wallet)
        : await login(wallet);

      // Save new tokens
      fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
      console.log(`[AccountManager] Account ${id} re-logged in successfully`);

      return true;
    } catch (err: any) {
      console.error(`[AccountManager] Failed to re-login account ${id}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Re-login all accounts using a shared browser session
   */
  private stopRelogin = false;
  private reloginSession: BrowserSession | undefined;

  stopReloginAll(): void {
    this.stopRelogin = true;
    if (this.reloginSession) {
      this.reloginSession.close().catch(() => {});
      this.reloginSession = undefined;
    }
  }

  async reloginAllAccounts(
    onProgress?: (done: number, total: number, message: string) => void,
  ): Promise<number> {
    const { openBrowserSession } = await import('../browser-auth');

    this.stopRelogin = false;
    let success = 0;
    const total = this.accounts.length;

    try {
      onProgress?.(0, total, 'Opening browser — complete the Cloudflare challenge...');
      this.reloginSession = await openBrowserSession();
      onProgress?.(0, total, 'Browser ready. Logging in accounts...');

      for (let i = 0; i < this.accounts.length; i++) {
        if (this.stopRelogin) {
          onProgress?.(i, total, 'Stopped by user');
          break;
        }

        const account = this.accounts[i];
        onProgress?.(i, total, `Logging in account ${account.id}...`);

        let error = '';
        const result = await this.reloginAccount(account.id, this.reloginSession).catch(err => {
          // Extract clean error from verbose playwright messages
          const msg = err.message || '';
          const match = msg.match(/Error: (.+?)(?:\n|$)/);
          error = match ? match[1] : msg.split('\n')[0];
          return false;
        });
        if (result) success++;
        onProgress?.(i + 1, total, result
          ? `Account ${account.id} OK (${success}/${i + 1})`
          : `Account ${account.id} FAIL: ${error} (${success}/${i + 1})`);

        if (i < this.accounts.length - 1 && !this.stopRelogin) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch (err: any) {
      console.error(`[AccountManager] Browser session error: ${err.message}`);
      onProgress?.(0, total, `Browser error: ${err.message}`);
      // Close session on error
      await this.reloginSession?.close();
      this.reloginSession = undefined;
    }
    // NOTE: session stays open for viewer WS connections

    return success;
  }

  getBrowserSession(): BrowserSession | undefined {
    return this.reloginSession;
  }

  async closeBrowserSession(): Promise<void> {
    await this.reloginSession?.close();
    this.reloginSession = undefined;
  }
}

export const accountManager = new AccountManager();
