/**
 * Account Manager
 *
 * Handles creation, storage, and loading of Axiom accounts
 */

import * as fs from 'fs';
import * as path from 'path';
import { Keypair } from '@solana/web3.js';
import { getOrCreateWallet, signup, login, type AuthTokens, type WalletInfo } from '../auth';
import type { ProxyManager } from './proxy-manager';

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

  async createAccount(proxyManager?: ProxyManager): Promise<StoredAccount | null> {
    const id = this.accounts.length + 1;
    const walletPath = path.join(ACCOUNTS_DIR, `wallet_${id}.json`);
    const tokensPath = path.join(ACCOUNTS_DIR, `tokens_${id}.json`);

    // Get next available proxy
    let proxy = null;
    let agent = undefined;

    if (proxyManager) {
      proxy = proxyManager.getNextAvailableProxy();
      if (proxy) {
        agent = proxyManager.getAgent(proxy);
      }
    }

    try {
      // Create wallet
      const wallet = getOrCreateWallet(walletPath);

      // Signup with optional proxy
      const tokens = await signup(wallet, agent);

      // Save tokens
      fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

      // Add to index
      const account: StoredAccount = {
        id,
        publicKey: wallet.publicKey,
        createdAt: new Date().toISOString(),
      };
      this.accounts.push(account);
      this.saveIndex();

      console.log(`[AccountManager] Account ${id} created${proxy ? ` via ${proxy.host}` : ''}`);
      return account;
    } catch (err: any) {
      // Mark proxy as used/bad on error - move to next
      if (proxy && proxyManager) {
        proxyManager.markProxyUsed(proxy);
      }

      console.error(`Failed to create account: ${err.message}`);
      throw err; // Re-throw to let caller handle
    }
  }

  async createAccounts(count: number, onProgress?: (created: number, total: number) => void): Promise<number> {
    let created = 0;

    for (let i = 0; i < count; i++) {
      const account = await this.createAccount();
      if (account) {
        created++;
      }
      onProgress?.(created, count);

      // Rate limit
      if (i < count - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    return created;
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
  async reloginAccount(id: number): Promise<boolean> {
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

      // Re-login
      console.log(`[AccountManager] Re-logging in account ${id}...`);
      const tokens = await login(wallet);

      // Save new tokens
      fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
      console.log(`[AccountManager] Account ${id} re-logged in successfully`);

      return true;
    } catch (err: any) {
      console.error(`[AccountManager] Failed to re-login account ${id}: ${err.message}`);
      return false;
    }
  }

  /**
   * Re-login all accounts
   */
  async reloginAllAccounts(onProgress?: (done: number, total: number) => void): Promise<number> {
    let success = 0;
    const total = this.accounts.length;

    for (let i = 0; i < this.accounts.length; i++) {
      const account = this.accounts[i];
      const result = await this.reloginAccount(account.id);
      if (result) success++;
      onProgress?.(i + 1, total);

      // Rate limit
      if (i < this.accounts.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    return success;
  }
}

export const accountManager = new AccountManager();
