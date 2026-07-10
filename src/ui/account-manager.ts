/**
 * Account Manager
 *
 * Source of truth: ./keys.txt — one base58 Solana secret key per line.
 * Token cache: ./accounts/tokens/{publicKey}.json
 * Account selection: ./accounts/selection.json — refresh/re-login/keep-warm selection.
 * Run selection:     ./accounts/run-selection.json — viewer-only selection.
 *
 * No more index.json, no wallet_*.json. Edit keys.txt to add/remove accounts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { login, loadWalletFromPrivateKey, type AuthTokens, type WalletInfo } from '../auth';
import type { BrowserSession } from '../browser-auth';
import { assignAccountsToProxyGroups, loadProxyFile, type ProxyAccountGroup, type ProxyConfig } from '../proxy-groups';
import {
  ACCESS_TOKEN_LIFETIME_MS,
  keepWarmRefreshThresholdMs,
  normalizeKeepWarmOptions,
  type KeepWarmTimingInput,
  type NormalizedKeepWarmOptions,
} from './keepwarm-config';

export interface AccountRecord {
  publicKey: string;
  hasTokens: boolean;
  tokenValid: boolean;
  selected: boolean;
  lastUsed?: string;
  /** Access-token JWT expiry, epoch-ms. Absent if no token or unparseable. */
  accessExpiresAt?: number;
}

/** Result of probing the per-IP refresh rate limit. */
export interface ProbeResult {
  /** Consecutive successful refreshes before the first 429 (or total if never throttled). */
  successesBeforeThrottle: number;
  /** Total refresh attempts made in phase 1. */
  attempted: number;
  /** Wall-clock of phase 1 (first request → throttle/end), ms. */
  elapsedMs: number;
  /** attempted / (elapsedMs in minutes) — observed back-to-back throughput. */
  requestsPerMin: number;
  /** True if a 429 was hit. */
  throttled: boolean;
  firstErrorStatus: number | null;
  firstErrorBody: string | null;
  /** Retry-After header value if the server exposed one (seconds). */
  retryAfterSec: number | null;
  /** Empirically measured cooldown: seconds from throttle to first recovery (null if not throttled or not recovered within the cap). */
  cooldownSec: number | null;
}

export interface LoadedAccount {
  publicKey: string;
  cookies: string;
  accessToken: string;
  refreshToken: string;
}

export interface RefreshAccountsResult {
  /** Actual /refresh-access-token successes. Fresh skipped accounts are not counted as refreshed. */
  success: number;
  /** Number of requested accounts. */
  total: number;
  /** Requested accounts with a refresh token whose access token is still fresh. */
  skippedFresh: number;
}

interface RefreshAttemptResult {
  ok: boolean;
  status: number | null;
  retryAfter: number | null;
  cdpError: string | null;
  message: string;
  throttled: boolean;
  deadToken: boolean;
}

interface KeepWarmStartOptions extends KeepWarmTimingInput {
  openProxySession?: (group: ProxyAccountGroup) => Promise<BrowserSession>;
}

export interface WarmProxyViewerGroup {
  id: number;
  label: string;
  session: BrowserSession;
  accounts: LoadedAccount[];
}

export interface WarmProxyViewerGroupsResult {
  ready: boolean;
  groups: WarmProxyViewerGroup[];
  missingGroups: { id: number; label: string; accounts: string[] }[];
  missingAccounts: string[];
  error?: string;
}

export interface AccountProxyGroupRecord {
  id: number;
  label: string;
  accounts: AccountRecord[];
}

export interface AccountProxyGroupsPayload {
  enabled: boolean;
  totalProxies: number;
  groups: AccountProxyGroupRecord[];
}

const KEYS_FILE = path.join(process.cwd(), 'keys.txt');
const ACCOUNTS_DIR = path.join(process.cwd(), 'accounts');
const TOKENS_DIR = path.join(ACCOUNTS_DIR, 'tokens');
const SELECTION_FILE = path.join(ACCOUNTS_DIR, 'selection.json');
const RUN_SELECTION_FILE = path.join(ACCOUNTS_DIR, 'run-selection.json');
const LEGACY_INDEX = path.join(ACCOUNTS_DIR, 'index.json');
const DEFAULT_REFRESH_THRESHOLD_MS = 3 * 60_000;
const DEFAULT_REFRESH_DELAY_MIN_MS = 2500;
const DEFAULT_REFRESH_DELAY_MAX_MS = 3500;
const VERIFY_WEIRD_ERROR_BACKOFF_MS = 15_000;

export function reloginFailureBackoffMs(message: string): number {
  if (/verify failed .*500 .*weird error/i.test(message)) return VERIFY_WEIRD_ERROR_BACKOFF_MS;
  return 0;
}

interface SelectionFile {
  selected: string[];
}

type SelectionScope = 'accounts' | 'run';

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

  private selectionPath(scope: SelectionScope): string {
    return scope === 'run' ? RUN_SELECTION_FILE : SELECTION_FILE;
  }

  private readSelection(scope: SelectionScope = 'accounts'): Set<string> {
    const filePath = this.selectionPath(scope);
    if (!fs.existsSync(filePath)) return new Set();
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SelectionFile;
      return new Set(Array.isArray(data.selected) ? data.selected : []);
    } catch {
      return new Set();
    }
  }

  private writeSelection(selected: Set<string>, scope: SelectionScope = 'accounts'): void {
    const file: SelectionFile = { selected: [...selected] };
    fs.writeFileSync(this.selectionPath(scope), JSON.stringify(file, null, 2));
  }

  setSelected(publicKey: string, selected: boolean): void {
    this.refreshKeys();
    if (!this.keyCache.has(publicKey)) return;
    const cur = this.readSelection('accounts');
    if (selected) cur.add(publicKey);
    else cur.delete(publicKey);
    this.writeSelection(cur, 'accounts');
  }

  setRunSelected(publicKey: string, selected: boolean): void {
    this.refreshKeys();
    if (!this.keyCache.has(publicKey)) return;
    const cur = this.readSelection('run');
    if (selected && this.isTokenValid(publicKey)) cur.add(publicKey);
    else cur.delete(publicKey);
    this.writeSelection(cur, 'run');
  }

  /** Replace the current selection with the given public keys (unknown keys ignored). */
  setSelection(publicKeys: string[]): void {
    this.refreshKeys();
    const valid = new Set(publicKeys.filter((pk) => this.keyCache.has(pk)));
    this.writeSelection(valid, 'accounts');
  }

  /** Replace the viewer-only selection with public keys that currently have valid tokens. */
  setRunSelection(publicKeys: string[]): void {
    this.refreshKeys();
    const valid = new Set(publicKeys.filter((pk) => this.keyCache.has(pk) && this.isTokenValid(pk)));
    this.writeSelection(valid, 'run');
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

  /** Access-token JWT `exp` in epoch-ms, or null if missing/unparseable. */
  private readAccessExp(publicKey: string): number | null {
    const t = this.readTokens(publicKey);
    if (!t?.accessToken) return null;
    const parts = t.accessToken.split('.');
    if (parts.length !== 3) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
      if (typeof payload.exp === 'number') return payload.exp * 1000;
    } catch {}
    return null;
  }

  private readTokenMtime(publicKey: string): number | null {
    try {
      return fs.statSync(this.tokenPath(publicKey)).mtimeMs;
    } catch {
      return null;
    }
  }

  /** Effective access expiry, capped to the observed 15-minute token lifetime. */
  private readAccessExpiresAt(publicKey: string): number | null {
    const exp = this.readAccessExp(publicKey);
    if (exp == null) return null;
    const mtime = this.readTokenMtime(publicKey);
    return mtime == null ? exp : Math.min(exp, mtime + ACCESS_TOKEN_LIFETIME_MS);
  }

  /** True if cached access-token JWT hasn't expired (with 60s safety). */
  isTokenValid(publicKey: string): boolean {
    const exp = this.readAccessExpiresAt(publicKey);
    if (exp != null) return exp - Date.now() > 60_000;
    // Fallback: file < 12h old (token present but no parseable exp)
    try {
      const stat = fs.statSync(this.tokenPath(publicKey));
      return Date.now() - stat.mtimeMs < 12 * 60 * 60 * 1000;
    } catch { return false; }
  }

  /** True when an account should consume refresh quota now. */
  private isRefreshDue(publicKey: string, thresholdMs = DEFAULT_REFRESH_THRESHOLD_MS): boolean {
    const tokens = this.readTokens(publicKey);
    if (!tokens?.refreshToken) return false;
    if (!tokens.accessToken) return true;

    const exp = this.readAccessExpiresAt(publicKey);
    if (exp != null) return exp - Date.now() <= thresholdMs;

    return !this.isTokenValid(publicKey);
  }

  // ─── public API ────────────────────────────────────────────────────────

  getAccountCount(): number {
    this.refreshKeys();
    return this.keyCache.size;
  }

  getSelectedCount(scope: SelectionScope = 'accounts'): number {
    this.refreshKeys();
    const selected = this.readSelection(scope);
    let count = 0;
    for (const pk of selected) {
      if (!this.keyCache.has(pk)) continue;
      if (scope === 'run' && !this.isTokenValid(pk)) continue;
      count++;
    }
    return count;
  }

  /** All accounts derived from keys.txt, with status + selection merged. */
  listAccounts(scope: SelectionScope = 'accounts'): AccountRecord[] {
    this.refreshKeys();
    const selected = this.readSelection(scope);
    const out: AccountRecord[] = [];
    for (const pk of this.keyCache.keys()) {
      const tokens = this.readTokens(pk);
      const tokenValid = this.isTokenValid(pk);
      let lastUsed: string | undefined;
      try {
        const stat = fs.statSync(this.tokenPath(pk));
        lastUsed = new Date(stat.mtimeMs).toISOString();
      } catch {}
      out.push({
        publicKey: pk,
        hasTokens: !!tokens,
        tokenValid,
        selected: selected.has(pk) && (scope !== 'run' || tokenValid),
        lastUsed,
        accessExpiresAt: this.readAccessExpiresAt(pk) ?? undefined,
      });
    }
    return out;
  }

  listRunAccounts(): AccountRecord[] {
    return this.listAccounts('run');
  }

  listProxyGroups(scope: SelectionScope = 'accounts'): AccountProxyGroupsPayload {
    this.refreshKeys();
    const proxies = loadProxyFile();
    if (proxies.length === 0) {
      return { enabled: false, totalProxies: 0, groups: [] };
    }

    const accounts = this.listAccounts(scope);
    const accountByPk = new Map(accounts.map((account) => [account.publicKey, account]));
    const groups = assignAccountsToProxyGroups(accounts.map((account) => account.publicKey), proxies)
      .map((group) => ({
        id: group.id,
        label: group.label,
        accounts: group.accounts
          .map((publicKey) => accountByPk.get(publicKey))
          .filter((account): account is AccountRecord => !!account),
      }));

    return { enabled: true, totalProxies: proxies.length, groups };
  }

  listRunProxyGroups(): AccountProxyGroupsPayload {
    return this.listProxyGroups('run');
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

  /** Explicitly selected accounts only. Empty selection means no accounts. */
  loadExplicitSelectedAccounts(): LoadedAccount[] {
    this.refreshKeys();
    const selected = this.readSelection();
    const out: LoadedAccount[] = [];
    for (const pk of this.keyCache.keys()) {
      if (!selected.has(pk)) continue;
      const a = this.loadAccount(pk);
      if (a) out.push(a);
    }
    return out;
  }

  /** Viewer-only selected accounts with valid tokens. Empty selection means no accounts. */
  loadExplicitRunSelectedAccounts(): LoadedAccount[] {
    this.refreshKeys();
    const selected = this.readSelection('run');
    const out: LoadedAccount[] = [];
    for (const pk of this.keyCache.keys()) {
      if (!selected.has(pk) || !this.isTokenValid(pk)) continue;
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

  /**
   * Refresh just the access token via /refresh-access-token. Fast — no
   * Turnstile, no signing. Falls back to false if the stored refresh token
   * is missing or the endpoint rejects it; caller can then escalate to a
   * full re-login.
   */
  async refreshAccount(publicKey: string, browserSession: BrowserSession): Promise<boolean> {
    return (await this.refreshAccountDetailed(publicKey, browserSession)).ok;
  }

  private classifyRefreshError(err: any): RefreshAttemptResult {
    const status = typeof err?.status === 'number' ? err.status : null;
    const retryAfter = typeof err?.retryAfter === 'number' && !Number.isNaN(err.retryAfter)
      ? err.retryAfter
      : null;
    const cdpError = typeof err?.cdpError === 'string' ? err.cdpError : null;
    const message = String(err?.message || err || 'refresh failed');
    const throttled = status === 429 || retryAfter != null || (status === 0 && !!cdpError);
    const noAccessCookie = err?.code === 'NO_ACCESS_COOKIE' || /no new auth-access-token cookie set/i.test(message);
    const deadToken = !throttled && (noAccessCookie || (status != null && [400, 401, 403, 404].includes(status)));
    return { ok: false, status, retryAfter, cdpError, message, throttled, deadToken };
  }

  private formatRefreshFailureDetail(result: RefreshAttemptResult): string {
    const parts: string[] = [];
    if (result.status != null) parts.push(`status=${result.status}`);
    if (result.retryAfter != null) parts.push(`retry-after=${result.retryAfter}s`);
    if (result.cdpError) parts.push(`net=${result.cdpError}`);
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
  }

  private async refreshAccountDetailed(
    publicKey: string,
    browserSession: BrowserSession,
    opts: { exclusive?: boolean } = {},
  ): Promise<RefreshAttemptResult> {
    const tokens = this.readTokens(publicKey);
    if (!tokens?.refreshToken) {
      console.log(`[AccountManager] ${publicKey.slice(0, 8)}: no refresh token — needs full login`);
      return {
        ok: false,
        status: null,
        retryAfter: null,
        cdpError: null,
        message: 'no refresh token',
        throttled: false,
        deadToken: true,
      };
    }
    try {
      const refresh = () => browserSession.refreshAccount(tokens.refreshToken);
      const fresh = opts.exclusive === false ? await refresh() : await this.runExclusive(refresh);
      this.writeTokens(publicKey, fresh);
      console.log(`[AccountManager] ${publicKey.slice(0, 8)}... refreshed`);
      return {
        ok: true,
        status: null,
        retryAfter: null,
        cdpError: null,
        message: '',
        throttled: false,
        deadToken: false,
      };
    } catch (err: any) {
      console.error(`[AccountManager] Refresh failed for ${publicKey.slice(0, 8)}: ${err.message}`);
      return this.classifyRefreshError(err);
    }
  }

  /**
   * Bulk refresh. Reuses the open browser session if one exists; otherwise
   * spins one up (which costs a CF challenge once). Returns counts only.
   */
  async refreshAccounts(
    targets: string[] | undefined,
    onProgress?: (done: number, total: number, message: string) => void,
  ): Promise<RefreshAccountsResult> {
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
    let success = 0;
    let completed = 0;
    if (total === 0) {
      onProgress?.(0, 0, 'No accounts selected');
      return { success, total, skippedFresh: 0 };
    }

    const refreshable = pool.filter((pk) => !!this.readTokens(pk)?.refreshToken);
    const noRefreshToken = total - refreshable.length;
    const due = refreshable.filter((pk) => this.isRefreshDue(pk));
    const skippedFresh = refreshable.length - due.length;

    if (skippedFresh > 0) {
      completed += skippedFresh;
      onProgress?.(completed, total, `${skippedFresh} already fresh, skipping`);
    }
    if (noRefreshToken > 0) {
      completed += noRefreshToken;
      onProgress?.(completed, total, `${noRefreshToken} account(s) have no refresh token, skipping`);
    }
    if (due.length === 0) {
      onProgress?.(
        total,
        total,
        skippedFresh > 0
          ? `All ${skippedFresh} refreshable account(s) are already fresh`
          : 'No selected accounts can be refreshed',
      );
      return { success, total, skippedFresh };
    }

    let session = this.reloginSession;
    let opened = false;
    if (!session) {
      onProgress?.(completed, total, 'Opening browser — complete the Cloudflare challenge...');
      const { openBrowserSession } = await import('../browser-auth');
      session = await openBrowserSession();
      this.reloginSession = session;
      opened = true;
    }

    const delayMinMs = DEFAULT_REFRESH_DELAY_MIN_MS;
    const delayMaxMs = DEFAULT_REFRESH_DELAY_MAX_MS;

    onProgress?.(completed, total, `Refreshing ${due.length} due account(s), 2.5-3.5s apart...`);
    for (let i = 0; i < due.length; i++) {
      if (this.stopRelogin) {
        onProgress?.(completed, total, 'Stopped by user');
        break;
      }
      const pk = due[i];
      onProgress?.(completed, total, `Refreshing ${pk.slice(0, 8)}...`);
      const ok = await this.refreshAccount(pk, session).catch(() => false);
      if (ok) success++;
      completed++;
      onProgress?.(completed, total, ok
        ? `${pk.slice(0, 8)} OK (${success}/${i + 1} refreshed; ${this.formatRefreshEta(due.length - i - 1, delayMinMs, delayMaxMs)})`
        : `${pk.slice(0, 8)} FAIL (${success}/${i + 1} refreshed; ${this.formatRefreshEta(due.length - i - 1, delayMinMs, delayMaxMs)})`);
      if (i < due.length - 1 && !this.stopRelogin) {
        await this.sleepUnlessReloginStopped(this.nextRefreshDelayMs(delayMinMs, delayMaxMs));
      }
    }

    // Leave session open if WE opened it AND viewers might use it. Caller
    // can close via stopReloginAll if they want to discard it.
    void opened;
    return { success, total, skippedFresh };
  }

  /**
   * Discover the per-IP refresh rate limit. Fires refreshes back-to-back
   * (serial, no gap) on up to `cap` accounts and counts consecutive successes
   * until the first 429. If throttled, then polls a single account every 5s
   * (capped at 3 min) until it recovers, measuring the cooldown empirically.
   * Refresh is non-destructive (rotated tokens are written back), so the only
   * cost is tripping the limit once. Cancellable via stopReloginAll().
   */
  async probeLimit(
    targets: string[] | undefined,
    cap: number,
    onProgress?: (message: string) => void,
  ): Promise<ProbeResult> {
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
    // Only accounts that actually have a refresh token can be probed.
    pool = pool
      .filter(pk => !!this.readTokens(pk)?.refreshToken)
      .slice(0, Math.max(1, Math.floor(cap)));

    const result: ProbeResult = {
      successesBeforeThrottle: 0, attempted: 0, elapsedMs: 0, requestsPerMin: 0,
      throttled: false, firstErrorStatus: null, firstErrorBody: null,
      retryAfterSec: null, cooldownSec: null,
    };
    if (pool.length === 0) {
      onProgress?.('No accounts with a refresh token to probe');
      return result;
    }

    let session = this.reloginSession;
    if (!session) {
      onProgress?.('Opening browser — complete the Cloudflare challenge...');
      session = await openBrowserSession();
      this.reloginSession = session;
    }

    onProgress?.(`Probing refresh limit on ${pool.length} account(s), back-to-back...`);
    const t0 = Date.now();

    // Phase 1 — ceiling: refresh back-to-back until the wall. The wall shows up
    // either as a clean 429 OR (observed on Axiom) as a burst of connection
    // failures once the IP cap is hit — the in-page fetch then reports status 0
    // / a net error. Two failures in a row is the wall; a lone failure is just
    // a dead account and we keep going.
    let consecutiveFails = 0;
    let wallHit = false;
    for (let i = 0; i < pool.length; i++) {
      if (this.stopRelogin) { onProgress?.('Stopped by user'); break; }
      const pk = pool[i];
      result.attempted++;
      try {
        const fresh = await this.runExclusive(() => session.refreshAccount(this.readTokens(pk)!.refreshToken));
        this.writeTokens(pk, fresh);
        result.successesBeforeThrottle++;
        consecutiveFails = 0;
        onProgress?.(`#${result.attempted} ${pk.slice(0, 8)} OK (${result.successesBeforeThrottle} ok)`);
      } catch (err: any) {
        const status = typeof err?.status === 'number' ? err.status : null;
        consecutiveFails++;
        if (result.firstErrorStatus == null) {
          result.firstErrorStatus = status;
          result.firstErrorBody = (err?.message || '').slice(0, 300);
          result.retryAfterSec = typeof err?.retryAfter === 'number' && !Number.isNaN(err.retryAfter) ? err.retryAfter : null;
        }
        const reason = err?.cdpError ? ` (${err.cdpError})` : '';
        onProgress?.(`#${result.attempted} ${pk.slice(0, 8)} FAIL status=${status ?? '?'}${reason} [${consecutiveFails} in a row]`);
        // 429 = unambiguous throttle; 2 failures in a row = the IP wall.
        if (status === 429 || consecutiveFails >= 2) { wallHit = true; break; }
      }
    }
    result.elapsedMs = Date.now() - t0;
    result.requestsPerMin = result.elapsedMs > 0
      ? Math.round((result.attempted / (result.elapsedMs / 60000)) * 10) / 10
      : 0;

    // Phase 2 — confirm + cooldown. Distinguish a real IP throttle from a run of
    // dead accounts: retry a KNOWN-GOOD account (pool[0] succeeded in phase 1).
    // If it still works, the failures were account-specific, not the IP.
    if (wallHit && !this.stopRelogin) {
      const probePk = pool[0];
      onProgress?.('Confirming with a known-good account...');
      let blocked = false;
      try {
        const fresh = await this.runExclusive(() => session.refreshAccount(this.readTokens(probePk)!.refreshToken));
        this.writeTokens(probePk, fresh);
        onProgress?.('Known-good account still refreshes — those failures were account-specific (likely stale tokens), NOT an IP rate limit.');
      } catch (err: any) {
        blocked = true;
        result.throttled = true;
        const status = typeof err?.status === 'number' ? err.status : null;
        onProgress?.(`IP throttled (known-good account now fails too, status=${status ?? '?'}). Measuring cooldown...`);
      }

      if (blocked) {
        const POLL_MS = 5000;
        const MAX_WAIT_MS = 600_000; // cap the wait at 10 min
        const tThrottle = Date.now();
        while (Date.now() - tThrottle < MAX_WAIT_MS) {
          if (this.stopRelogin) { onProgress?.('Stopped by user'); break; }
          await new Promise(r => setTimeout(r, POLL_MS));
          try {
            const fresh = await session.refreshAccount(this.readTokens(probePk)!.refreshToken);
            this.writeTokens(probePk, fresh);
            result.cooldownSec = Math.round((Date.now() - tThrottle) / 1000);
            onProgress?.(`Recovered after ${result.cooldownSec}s — cooldown measured`);
            break;
          } catch {
            const waited = Math.round((Date.now() - tThrottle) / 1000);
            onProgress?.(`still throttled after ${waited}s...`);
          }
        }
        if (result.cooldownSec == null) {
          onProgress?.(`Still throttled after ${Math.round(MAX_WAIT_MS / 1000)}s (cooldown longer than 10 min cap)`);
        }
      }
    }

    if (result.throttled) {
      onProgress?.(`Done: ceiling ~${result.successesBeforeThrottle} refreshes/IP, cooldown ${result.cooldownSec != null ? result.cooldownSec + 's' : '>600s'}, ~${result.requestsPerMin}/min`);
    } else if (wallHit) {
      onProgress?.(`Done: ${result.successesBeforeThrottle} OK then account-specific failures (no IP throttle confirmed). ~${result.requestsPerMin}/min`);
    } else {
      onProgress?.(`Done: no throttle in ${result.attempted} refreshes (~${result.requestsPerMin}/min). Raise the cap to push harder.`);
    }
    return result;
  }

  async reloginAccount(publicKey: string, browserSession?: BrowserSession): Promise<boolean> {
    const wallet = this.walletFor(publicKey);
    if (!wallet) {
      console.error(`[AccountManager] No key in keys.txt for ${publicKey}`);
      return false;
    }
    try {
      console.log(`[AccountManager] Re-logging in ${publicKey.slice(0, 8)}...`);
      const tokens = await this.runExclusive(() =>
        browserSession ? browserSession.loginAccount(wallet) : login(wallet),
      );
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
  private keepWarmProxySessions: Map<number, BrowserSession> = new Map();
  private keepWarmProxyGroups: Map<number, ProxyAccountGroup> = new Map();

  // Keep-logged-in (background refresh loop) state.
  private keepWarm = { running: false, fails: new Map<string, number>(), dead: new Set<string>() };

  // Serializes every browser refresh/login operation. The shared browser
  // context cookie jar is NOT concurrency-safe (browser-auth.refreshAccount has
  // no lock), so the background keep-warm loop must not interleave with a manual
  // refresh / re-login / probe. All of them funnel their browser call through
  // runExclusive.
  private opLock: Promise<void> = Promise.resolve();
  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.opLock;
    let release!: () => void;
    this.opLock = new Promise<void>((r) => (release = r));
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Sleep that wakes early if keep-warm is stopped, so Stop feels responsive. */
  private async sleepUnlessStopped(ms: number): Promise<void> {
    const step = 250;
    let waited = 0;
    while (waited < ms && this.keepWarm.running) {
      await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
      waited += step;
    }
  }

  /** Sleep that wakes early if a manual refresh/re-login is stopped. */
  private async sleepUnlessReloginStopped(ms: number): Promise<void> {
    const step = 250;
    let waited = 0;
    while (waited < ms && !this.stopRelogin) {
      await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
      waited += step;
    }
  }

  private nextRefreshDelayMs(minMs: number, maxMs: number): number {
    if (maxMs <= minMs) return minMs;
    return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  }

  private formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  }

  private formatRefreshEta(remaining: number, minDelayMs: number, maxDelayMs: number): string {
    if (remaining <= 0) return 'all due accounts refreshed';
    const minMs = remaining * minDelayMs;
    const maxMs = remaining * maxDelayMs;
    if (minMs === maxMs) return `ETA ~${this.formatDuration(minMs)} left`;
    return `ETA ~${this.formatDuration(minMs)}-${this.formatDuration(maxMs)} left`;
  }

  isKeepWarmRunning(): boolean {
    return this.keepWarm.running;
  }

  stopReloginAll(): void {
    this.stopRelogin = true;
    this.keepWarm.running = false;
    this.closeKeepWarmProxySessions();
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

  private buildProxyGroupsForPool(pool: string[], proxies: ProxyConfig[]): ProxyAccountGroup[] {
    const poolSet = new Set(pool);
    return assignAccountsToProxyGroups([...this.keyCache.keys()], proxies)
      .map((group) => ({
        ...group,
        accounts: group.accounts.filter((publicKey) => poolSet.has(publicKey)),
      }))
      .filter((group) => group.accounts.length > 0);
  }

  hasConfiguredProxies(): boolean {
    return loadProxyFile().length > 0;
  }

  getWarmProxyViewerGroups(accounts: LoadedAccount[]): WarmProxyViewerGroupsResult {
    const result: WarmProxyViewerGroupsResult = {
      ready: false,
      groups: [],
      missingGroups: [],
      missingAccounts: [],
    };

    if (accounts.length === 0) {
      result.error = 'No accounts selected or none have valid tokens. Re-login first.';
      return result;
    }

    if (loadProxyFile().length === 0) {
      result.error = 'No proxies configured.';
      return result;
    }

    if (!this.keepWarm.running || this.keepWarmProxyGroups.size === 0) {
      result.error = 'Start keep-warm first so proxy groups are ready.';
      result.missingAccounts = accounts.map((account) => account.publicKey);
      return result;
    }

    const accountByPk = new Map(accounts.map((account) => [account.publicKey, account]));
    const assigned = new Set<string>();

    for (const group of this.keepWarmProxyGroups.values()) {
      const groupAccounts = group.accounts
        .map((publicKey) => accountByPk.get(publicKey))
        .filter((account): account is LoadedAccount => !!account);
      if (groupAccounts.length === 0) continue;

      for (const account of groupAccounts) assigned.add(account.publicKey);
      const session = this.keepWarmProxySessions.get(group.id);
      if (!session) {
        result.missingGroups.push({
          id: group.id,
          label: group.label,
          accounts: groupAccounts.map((account) => account.publicKey),
        });
        continue;
      }

      result.groups.push({
        id: group.id,
        label: group.label,
        session,
        accounts: groupAccounts,
      });
    }

    result.missingAccounts = accounts
      .map((account) => account.publicKey)
      .filter((publicKey) => !assigned.has(publicKey));

    result.ready = result.groups.length > 0 &&
      result.missingGroups.length === 0 &&
      result.missingAccounts.length === 0;
    if (!result.ready && !result.error) {
      result.error = 'Start keep-warm first so proxy groups are ready.';
    }
    return result;
  }

  async closeBrowserSession(): Promise<void> {
    await this.reloginSession?.close();
    this.reloginSession = undefined;
    this.closeKeepWarmProxySessions();
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
          const backoffMs = ok ? 0 : reloginFailureBackoffMs(error);
          if (backoffMs > 0) {
            onProgress?.(done, total, `Verify returned Weird Error — backing off ${Math.round(backoffMs / 1000)}s before next login...`);
            await this.sleepUnlessReloginStopped(backoffMs);
          } else {
            await new Promise(r => setTimeout(r, 500));
          }
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

  /**
   * Keep selected accounts logged in by refreshing them forever (refresh-only —
   * never a full re-login, since login has its own stricter limits). Every pass
   * refreshes each account when it falls into that account's configured
   * refresh-age window. Proxy mode runs one independent worker per proxy group.
   * On the wall it backs off ~35s; an account
   * whose refresh keeps failing is flagged dead (needs a manual re-login) and
   * skipped. Runs in the background; the returned promise resolves once the loop
   * has started. Stop with stopKeepLoggedIn() or stopReloginAll().
   */
  async startKeepLoggedIn(
    targets: string[] | undefined,
    opts: KeepWarmStartOptions = {},
    onProgress?: (message: string, running: boolean) => void,
  ): Promise<void> {
    if (this.keepWarm.running) {
      onProgress?.('Keep-logged-in already running', true);
      return;
    }
    const { openBrowserSession, buildProxyKeepWarmBrowserSessionOptions } = await import('../browser-auth');
    this.refreshKeys();
    this.stopRelogin = false;
    this.keepWarm.running = true;
    this.keepWarm.fails.clear();
    this.keepWarm.dead.clear();
    this.keepWarmProxyGroups.clear();

    const timing = normalizeKeepWarmOptions(opts);
    const delayMinMs = timing.refreshDelayMs.min;
    const delayMaxMs = timing.refreshDelayMs.max;
    const proxies = loadProxyFile();
    const proxyMode = proxies.length > 0;

    const resolvePool = (): string[] => {
      this.refreshKeys();
      if (targets && targets.length > 0) return targets.filter((k) => this.keyCache.has(k));
      const selected = this.readSelection();
      return selected.size > 0
        ? [...this.keyCache.keys()].filter((k) => selected.has(k))
        : [...this.keyCache.keys()];
    };

    let session = this.reloginSession;
    if (!proxyMode && !session) {
      onProgress?.('Opening browser — complete the Cloudflare challenge...', true);
      try {
        session = await openBrowserSession();
        this.reloginSession = session;
      } catch (err: any) {
        this.keepWarm.running = false;
        onProgress?.(`Browser error: ${err.message}`, false);
        return;
      }
    }
    const browser = session;

    const getProxySession = async (group: ProxyAccountGroup): Promise<BrowserSession> => {
      const existing = this.keepWarmProxySessions.get(group.id);
      if (existing) return existing;

      onProgress?.(`[${group.label}] opening browser for ${group.accounts.length} account(s)...`, true);
      const next = opts.openProxySession
        ? await opts.openProxySession(group)
        : await openBrowserSession(buildProxyKeepWarmBrowserSessionOptions(
            group.proxy,
            group.label,
            (message) => onProgress?.(message, true),
          ));
      this.keepWarmProxySessions.set(group.id, next);
      return next;
    };

    const isDueForKeepWarm = (pk: string): boolean =>
      this.isRefreshDue(pk, keepWarmRefreshThresholdMs(pk, timing));

    const initialPool = resolvePool();
    if (initialPool.length === 0) {
      this.keepWarm.running = false;
      onProgress?.('No accounts selected', false);
      return;
    }

    const groups = proxyMode
      ? this.buildProxyGroupsForPool(initialPool, proxies)
      : [{
          id: 0,
          label: 'direct',
          accounts: initialPool,
          proxy: { id: 0, label: 'direct', server: '' },
        }];

    if (groups.length === 0) {
      this.keepWarm.running = false;
      onProgress?.('No accounts selected', false);
      return;
    }
    if (proxyMode) {
      this.keepWarmProxyGroups = new Map(groups.map((group) => [group.id, group]));
    }

    onProgress?.(
      proxyMode
        ? `Keep-logged-in started in proxy mode — ${groups.length} group(s), ${this.formatDuration(timing.groupStartDelayMs.min)}-${this.formatDuration(timing.groupStartDelayMs.max)} group stagger, ${this.formatDuration(delayMinMs)}-${this.formatDuration(delayMaxMs)} in-group delay.`
        : `Keep-logged-in started — refresh-only, ${this.formatDuration(delayMinMs)}-${this.formatDuration(delayMaxMs)} apart.`,
      true,
    );

    const runGroup = async (
      group: ProxyAccountGroup,
      startDelayMs: number,
      options: NormalizedKeepWarmOptions,
    ): Promise<void> => {
      const groupPrefix = proxyMode ? `[${group.label}] ` : '';
      if (startDelayMs > 0) {
        onProgress?.(`${groupPrefix}starting in ${this.formatDuration(startDelayMs)}...`, true);
        await this.sleepUnlessStopped(startDelayMs);
      }

      let initialGroupPass = true;
      let consecutiveNetworkFails = 0;
      let cooldownUntil = 0;
      let groupBrowser: BrowserSession | undefined;

      while (this.keepWarm.running) {
        this.refreshKeys();

        if (cooldownUntil > Date.now()) {
          await this.sleepUnlessStopped(Math.min(cooldownUntil - Date.now(), 5000));
          continue;
        }

        if (proxyMode && !groupBrowser) {
          try {
            groupBrowser = await getProxySession(group);
          } catch (err: any) {
            onProgress?.(`${groupPrefix}browser error: ${err.message}; cooling down 60s`, true);
            cooldownUntil = Date.now() + 60_000;
            continue;
          }
        }

        const groupAccounts = group.accounts
          .filter((pk) => this.keyCache.has(pk))
          .filter((pk) => !this.keepWarm.dead.has(pk));
        const withRt = groupAccounts.filter((pk) => !!this.readTokens(pk)?.refreshToken);
        const noRt = groupAccounts.filter((pk) => !this.readTokens(pk)?.refreshToken);

        const due = withRt.filter(isDueForKeepWarm);
        if (initialGroupPass) {
          if (noRt.length > 0) {
            onProgress?.(`${groupPrefix}${noRt.length} account(s) have no refresh token — they need a manual re-login and won't be kept warm.`, true);
          }
          const skippedFresh = withRt.length - due.length;
          if (skippedFresh > 0) {
            onProgress?.(`${groupPrefix}${skippedFresh} account(s) already fresh — skipping until near expiry.`, true);
          }
          initialGroupPass = false;
        }

        if (due.length === 0) {
          await this.sleepUnlessStopped(5000);
          continue;
        }

        try {
          groupBrowser = proxyMode ? groupBrowser ?? await getProxySession(group) : browser!;
        } catch (err: any) {
          onProgress?.(`${groupPrefix}browser error: ${err.message}; cooling down 60s`, true);
          cooldownUntil = Date.now() + 60_000;
          continue;
        }

        for (let i = 0; i < due.length; i++) {
          const pk = due[i];
          if (!this.keepWarm.running) break;
          const result = await this.refreshAccountDetailed(pk, groupBrowser, { exclusive: !proxyMode })
            .catch((err: any) => this.classifyRefreshError(err));

          if (result.ok) {
            consecutiveNetworkFails = 0;
            this.keepWarm.fails.delete(pk);
            onProgress?.(
              `${groupPrefix}refreshed ${pk.slice(0, 8)} (${i + 1}/${due.length}; ${this.formatRefreshEta(due.length - i - 1, options.refreshDelayMs.min, options.refreshDelayMs.max)})`,
              true,
            );
          } else if (result.deadToken) {
            consecutiveNetworkFails = 0;
            this.keepWarm.fails.delete(pk);
            this.keepWarm.dead.add(pk);
            onProgress?.(`${groupPrefix}${pk.slice(0, 8)} can't be refreshed${this.formatRefreshFailureDetail(result)} — needs manual re-login. Skipping.`, true);
          } else if (result.throttled) {
            consecutiveNetworkFails = 0;
            const cooldownMs = result.retryAfter != null ? Math.max(35_000, result.retryAfter * 1000) : 35_000;
            cooldownUntil = Date.now() + cooldownMs;
            onProgress?.(`${groupPrefix}hit the refresh rate limit${this.formatRefreshFailureDetail(result)} — cooling this group for ${this.formatDuration(cooldownMs)}...`, true);
            break;
          } else if (result.status === 0) {
            consecutiveNetworkFails++;
            onProgress?.(`${groupPrefix}refresh failed for ${pk.slice(0, 8)}${this.formatRefreshFailureDetail(result)} (will retry)`, true);
            if (consecutiveNetworkFails >= 3) {
              onProgress?.(`${groupPrefix}browser/network refresh failures (status=0) — backing off this group for 30s...`, true);
              cooldownUntil = Date.now() + 30_000;
              consecutiveNetworkFails = 0;
              break;
            }
          } else {
            consecutiveNetworkFails = 0;
            const f = (this.keepWarm.fails.get(pk) ?? 0) + 1;
            this.keepWarm.fails.set(pk, f);
            onProgress?.(`${groupPrefix}refresh failed for ${pk.slice(0, 8)}${this.formatRefreshFailureDetail(result)} (will retry)`, true);
          }

          if (!this.keepWarm.running) break;
          if (i < due.length - 1) {
            await this.sleepUnlessStopped(this.nextRefreshDelayMs(options.refreshDelayMs.min, options.refreshDelayMs.max));
          }
        }
      }
    };

    let nextGroupStartOffsetMs = 0;
    const workers = groups.map((group) => {
      const startDelayMs = proxyMode ? nextGroupStartOffsetMs : 0;
      if (proxyMode) {
        nextGroupStartOffsetMs += this.nextRefreshDelayMs(timing.groupStartDelayMs.min, timing.groupStartDelayMs.max);
      }
      return runGroup(group, startDelayMs, timing);
    });

    // Background loop — intentionally not awaited by the caller.
    void (async () => {
      try {
        await Promise.all(workers);
      } finally {
        if (proxyMode) this.closeKeepWarmProxySessions();
        onProgress?.('Keep-logged-in stopped', false);
      }
    })();
  }

  stopKeepLoggedIn(): void {
    this.keepWarm.running = false;
    this.closeKeepWarmProxySessions();
  }

  private closeKeepWarmProxySessions(): void {
    for (const session of this.keepWarmProxySessions.values()) {
      session.close().catch(() => {});
    }
    this.keepWarmProxySessions.clear();
    this.keepWarmProxyGroups.clear();
  }
}

export const accountManager = new AccountManager();
