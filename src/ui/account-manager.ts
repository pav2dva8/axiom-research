/**
 * Account Manager
 *
 * Source of truth: ./keys.txt — one base58 Solana secret key per line.
 * Token cache: ./accounts/tokens/{publicKey}.json
 * Selection:   ./accounts/selection.json — array of selected publicKeys.
 *
 * No more index.json, no wallet_*.json. Edit keys.txt to add/remove accounts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { login, loadWalletFromPrivateKey, type AuthTokens, type WalletInfo } from '../auth';
import type { BrowserSession } from '../browser-auth';

export interface AccountRecord {
  publicKey: string;
  hasTokens: boolean;
  tokenValid: boolean;
  selected: boolean;
  lastUsed?: string;
}

export interface LoadedAccount {
  publicKey: string;
  cookies: string;
  accessToken: string;
  refreshToken: string;
}

const KEYS_FILE = path.join(process.cwd(), 'keys.txt');
const ACCOUNTS_DIR = path.join(process.cwd(), 'accounts');
const TOKENS_DIR = path.join(ACCOUNTS_DIR, 'tokens');
const SELECTION_FILE = path.join(ACCOUNTS_DIR, 'selection.json');
const LEGACY_INDEX = path.join(ACCOUNTS_DIR, 'index.json');

interface SelectionFile {
  selected: string[];
}

export class AccountManager {
  // Cache: publicKey -> base58 secret. Rebuilt every time keys.txt changes.
  private keyCache: Map<string, string> = new Map();
  private keysMtime = 0;

  constructor() {
    this.ensureDirs();
    this.migrateLegacy();
    this.refreshKeys();
  }

  private ensureDirs(): void {
    if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });
  }

  /**
   * Move legacy data into the new layout exactly once. We never overwrite
   * keys.txt without confirmation: legacy private keys are appended only if
   * their publicKey isn't already represented.
   */
  private migrateLegacy(): void {
    const legacyWallets = fs.readdirSync(ACCOUNTS_DIR)
      .filter(f => /^wallet_\d+\.json$/.test(f))
      .map(f => path.join(ACCOUNTS_DIR, f));
    const legacyTokens = fs.readdirSync(ACCOUNTS_DIR)
      .filter(f => /^tokens_\d+\.json$/.test(f));

    if (legacyWallets.length === 0 && legacyTokens.length === 0 && !fs.existsSync(LEGACY_INDEX)) {
      return;
    }

    console.log('[AccountManager] Migrating legacy account files...');

    // 1. Build pubkey -> {secret, tokens} from each wallet_{id}.json
    const existingKeys = this.readKeysFile();
    const existingPubkeys = new Set<string>();
    for (const k of existingKeys) {
      try { existingPubkeys.add(loadWalletFromPrivateKey(k).publicKey); } catch {}
    }

    const linesToAppend: string[] = [];
    for (const walletPath of legacyWallets) {
      const idMatch = path.basename(walletPath).match(/wallet_(\d+)\.json$/);
      if (!idMatch) continue;
      const id = idMatch[1];
      try {
        const data = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
        const secretKey = Uint8Array.from(data.secretKey);
        const keypair = Keypair.fromSecretKey(secretKey);
        const pubkey = keypair.publicKey.toBase58();
        const secretBase58 = bs58.encode(secretKey);

        if (!existingPubkeys.has(pubkey)) {
          linesToAppend.push(secretBase58);
          existingPubkeys.add(pubkey);
        }

        const legacyTokenFile = path.join(ACCOUNTS_DIR, `tokens_${id}.json`);
        if (fs.existsSync(legacyTokenFile)) {
          const targetTokenFile = path.join(TOKENS_DIR, `${pubkey}.json`);
          if (!fs.existsSync(targetTokenFile)) {
            fs.copyFileSync(legacyTokenFile, targetTokenFile);
          }
          fs.unlinkSync(legacyTokenFile);
        }
      } catch (err: any) {
        console.warn(`[AccountManager] Failed to migrate ${walletPath}: ${err.message}`);
      }
      try { fs.unlinkSync(walletPath); } catch {}
    }

    if (linesToAppend.length > 0) {
      const existing = fs.existsSync(KEYS_FILE) ? fs.readFileSync(KEYS_FILE, 'utf-8') : '';
      const sep = existing && !existing.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(KEYS_FILE, existing + sep + linesToAppend.join('\n') + '\n');
      console.log(`[AccountManager] Appended ${linesToAppend.length} legacy key(s) to keys.txt`);
    }

    // Drop any orphan tokens_{id}.json that weren't paired with a wallet
    for (const f of legacyTokens) {
      const p = path.join(ACCOUNTS_DIR, f);
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
    }

    if (fs.existsSync(LEGACY_INDEX)) {
      try { fs.unlinkSync(LEGACY_INDEX); } catch {}
    }

    console.log('[AccountManager] Legacy migration complete.');
  }

  // ─── keys.txt handling ─────────────────────────────────────────────────

  private readKeysFile(): string[] {
    if (!fs.existsSync(KEYS_FILE)) return [];
    return fs.readFileSync(KEYS_FILE, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .filter(l => !l.startsWith('#'));
  }

  /** Reload key cache if keys.txt changed since last read. */
  private refreshKeys(): void {
    let mtime = 0;
    try { mtime = fs.statSync(KEYS_FILE).mtimeMs; } catch { mtime = 0; }
    if (mtime === this.keysMtime && this.keyCache.size > 0) return;
    this.keysMtime = mtime;
    this.keyCache.clear();
    for (const line of this.readKeysFile()) {
      try {
        const w = loadWalletFromPrivateKey(line);
        this.keyCache.set(w.publicKey, line);
      } catch {
        console.warn(`[AccountManager] Skipping invalid key line: ${line.slice(0, 8)}...`);
      }
    }
    this.pruneOrphanTokens();
  }

  /** Delete cached tokens for pubkeys no longer in keys.txt. */
  private pruneOrphanTokens(): void {
    if (!fs.existsSync(TOKENS_DIR)) return;
    for (const f of fs.readdirSync(TOKENS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const pk = f.replace(/\.json$/, '');
      if (!this.keyCache.has(pk)) {
        try { fs.unlinkSync(path.join(TOKENS_DIR, f)); } catch {}
      }
    }
  }

  // ─── selection.json handling ───────────────────────────────────────────

  private readSelection(): Set<string> {
    if (!fs.existsSync(SELECTION_FILE)) return new Set();
    try {
      const data = JSON.parse(fs.readFileSync(SELECTION_FILE, 'utf-8')) as SelectionFile;
      return new Set(Array.isArray(data.selected) ? data.selected : []);
    } catch {
      return new Set();
    }
  }

  private writeSelection(selected: Set<string>): void {
    const file: SelectionFile = { selected: [...selected] };
    fs.writeFileSync(SELECTION_FILE, JSON.stringify(file, null, 2));
  }

  setSelected(publicKey: string, selected: boolean): void {
    this.refreshKeys();
    if (!this.keyCache.has(publicKey)) return;
    const cur = this.readSelection();
    if (selected) cur.add(publicKey);
    else cur.delete(publicKey);
    this.writeSelection(cur);
  }

  /** Replace the current selection with the given public keys (unknown keys ignored). */
  setSelection(publicKeys: string[]): void {
    this.refreshKeys();
    const valid = new Set(publicKeys.filter((pk) => this.keyCache.has(pk)));
    this.writeSelection(valid);
  }

  // ─── tokens cache ──────────────────────────────────────────────────────

  private tokenPath(publicKey: string): string {
    return path.join(TOKENS_DIR, `${publicKey}.json`);
  }

  private readTokens(publicKey: string): AuthTokens | null {
    const p = this.tokenPath(publicKey);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as AuthTokens; }
    catch { return null; }
  }

  private writeTokens(publicKey: string, tokens: AuthTokens): void {
    fs.writeFileSync(this.tokenPath(publicKey), JSON.stringify(tokens, null, 2));
  }

  /** True if cached access-token JWT hasn't expired (with 60s safety). */
  isTokenValid(publicKey: string): boolean {
    const t = this.readTokens(publicKey);
    if (!t?.accessToken) return false;
    const parts = t.accessToken.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        if (typeof payload.exp === 'number') {
          return payload.exp - Date.now() / 1000 > 60;
        }
      } catch {}
    }
    // Fallback: file < 12h old
    try {
      const stat = fs.statSync(this.tokenPath(publicKey));
      return Date.now() - stat.mtimeMs < 12 * 60 * 60 * 1000;
    } catch { return false; }
  }

  // ─── public API ────────────────────────────────────────────────────────

  getAccountCount(): number {
    this.refreshKeys();
    return this.keyCache.size;
  }

  getSelectedCount(): number {
    this.refreshKeys();
    const selected = this.readSelection();
    let count = 0;
    for (const pk of selected) {
      if (this.keyCache.has(pk)) count++;
    }
    return count;
  }

  /** All accounts derived from keys.txt, with status + selection merged. */
  listAccounts(): AccountRecord[] {
    this.refreshKeys();
    const selected = this.readSelection();
    const out: AccountRecord[] = [];
    for (const pk of this.keyCache.keys()) {
      const tokens = this.readTokens(pk);
      let lastUsed: string | undefined;
      try {
        const stat = fs.statSync(this.tokenPath(pk));
        lastUsed = new Date(stat.mtimeMs).toISOString();
      } catch {}
      out.push({
        publicKey: pk,
        hasTokens: !!tokens,
        tokenValid: this.isTokenValid(pk),
        selected: selected.has(pk),
        lastUsed,
      });
    }
    return out;
  }

  loadAccount(publicKey: string): LoadedAccount | null {
    this.refreshKeys();
    if (!this.keyCache.has(publicKey)) return null;
    const tokens = this.readTokens(publicKey);
    if (!tokens) return null;
    return {
      publicKey,
      cookies: tokens.cookies,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  /** Selected accounts that currently have valid tokens, ready to view. */
  loadSelectedAccounts(): LoadedAccount[] {
    this.refreshKeys();
    const selected = this.readSelection();
    const pool = selected.size > 0
      ? [...this.keyCache.keys()].filter(k => selected.has(k))
      : [...this.keyCache.keys()];
    const out: LoadedAccount[] = [];
    for (const pk of pool) {
      const a = this.loadAccount(pk);
      if (a) out.push(a);
    }
    return out;
  }

  /** All accounts that have valid tokens, ignoring selection. */
  loadAllAccounts(): LoadedAccount[] {
    this.refreshKeys();
    const out: LoadedAccount[] = [];
    for (const pk of this.keyCache.keys()) {
      const a = this.loadAccount(pk);
      if (a) out.push(a);
    }
    return out;
  }

  // ─── re-login ──────────────────────────────────────────────────────────

  private walletFor(publicKey: string): WalletInfo | null {
    this.refreshKeys();
    const secret = this.keyCache.get(publicKey);
    if (!secret) return null;
    return loadWalletFromPrivateKey(secret);
  }

  async reloginAccount(publicKey: string, browserSession?: BrowserSession): Promise<boolean> {
    const wallet = this.walletFor(publicKey);
    if (!wallet) {
      console.error(`[AccountManager] No key in keys.txt for ${publicKey}`);
      return false;
    }
    try {
      console.log(`[AccountManager] Re-logging in ${publicKey.slice(0, 8)}...`);
      const tokens = browserSession
        ? await browserSession.loginAccount(wallet)
        : await login(wallet);
      this.writeTokens(publicKey, tokens);
      console.log(`[AccountManager] ${publicKey.slice(0, 8)}... re-logged in`);
      return true;
    } catch (err: any) {
      console.error(`[AccountManager] Re-login failed for ${publicKey.slice(0, 8)}: ${err.message}`);
      throw err;
    }
  }

  // ─── browser session shared between login + viewers ────────────────────

  private stopRelogin = false;
  private reloginSession: BrowserSession | undefined;

  stopReloginAll(): void {
    this.stopRelogin = true;
    if (this.reloginSession) {
      this.reloginSession.close().catch(() => {});
      this.reloginSession = undefined;
    }
  }

  getBrowserSession(): BrowserSession | undefined {
    return this.reloginSession;
  }

  setBrowserSession(session: BrowserSession): void {
    this.reloginSession = session;
  }

  async closeBrowserSession(): Promise<void> {
    await this.reloginSession?.close();
    this.reloginSession = undefined;
  }

  /**
   * Re-login a chosen list of pubkeys. If `targets` is omitted, re-logs the
   * currently selected accounts; if there is no selection, re-logs all.
   */
  async reloginAccounts(
    targets: string[] | undefined,
    onProgress?: (done: number, total: number, message: string) => void,
  ): Promise<{ success: number; total: number }> {
    const { openBrowserSession } = await import('../browser-auth');
    this.refreshKeys();
    this.stopRelogin = false;

    let pool: string[];
    if (targets && targets.length > 0) {
      pool = targets.filter(k => this.keyCache.has(k));
    } else {
      const selected = this.readSelection();
      pool = selected.size > 0
        ? [...this.keyCache.keys()].filter(k => selected.has(k))
        : [...this.keyCache.keys()];
    }

    const total = pool.length;
    const needsLogin = pool.filter(k => !this.isTokenValid(k));
    const alreadyValid = pool.filter(k => this.isTokenValid(k));
    let success = alreadyValid.length;

    if (alreadyValid.length > 0) {
      onProgress?.(0, total, `${alreadyValid.length} already logged in, skipping`);
    }
    if (needsLogin.length === 0) {
      onProgress?.(total, total, `All ${total} accounts already logged in`);
      return { success, total };
    }

    if (this.reloginSession) {
      await this.reloginSession.close().catch(() => {});
      this.reloginSession = undefined;
    }

    try {
      onProgress?.(alreadyValid.length, total, 'Opening browser — complete the Cloudflare challenge...');
      this.reloginSession = await openBrowserSession();
      onProgress?.(alreadyValid.length, total, `Browser ready. Logging in ${needsLogin.length} account(s)...`);

      for (let i = 0; i < needsLogin.length; i++) {
        if (this.stopRelogin) {
          onProgress?.(alreadyValid.length + i, total, 'Stopped by user');
          break;
        }
        const pk = needsLogin[i];
        onProgress?.(alreadyValid.length + i, total, `Logging in ${pk.slice(0, 8)}...`);

        let error = '';
        const ok = await this.reloginAccount(pk, this.reloginSession).catch((err: any) => {
          const msg = err.message || '';
          const m = msg.match(/Error: (.+?)(?:\n|$)/);
          error = m ? m[1] : msg.split('\n')[0];
          return false;
        });
        if (ok) success++;

        const done = alreadyValid.length + i + 1;
        onProgress?.(done, total, ok
          ? `${pk.slice(0, 8)} OK (${success}/${done})`
          : `${pk.slice(0, 8)} FAIL: ${error} (${success}/${done})`);

        if (i < needsLogin.length - 1 && !this.stopRelogin) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch (err: any) {
      console.error(`[AccountManager] Browser session error: ${err.message}`);
      onProgress?.(0, total, `Browser error: ${err.message}`);
      await this.reloginSession?.close().catch(() => {});
      this.reloginSession = undefined;
    }
    // NOTE: session stays open for viewer WS connections

    return { success, total };
  }
}

export const accountManager = new AccountManager();
