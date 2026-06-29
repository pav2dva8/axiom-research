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

  /** True if cached access-token JWT hasn't expired (with 60s safety). */
  isTokenValid(publicKey: string): boolean {
    const exp = this.readAccessExp(publicKey);
    if (exp != null) return exp - Date.now() > 60_000;
    // Fallback: file < 12h old (token present but no parseable exp)
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
        accessExpiresAt: this.readAccessExp(pk) ?? undefined,
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

  /**
   * Refresh just the access token via /refresh-access-token. Fast — no
   * Turnstile, no signing. Falls back to false if the stored refresh token
   * is missing or the endpoint rejects it; caller can then escalate to a
   * full re-login.
   */
  async refreshAccount(publicKey: string, browserSession: BrowserSession): Promise<boolean> {
    const tokens = this.readTokens(publicKey);
    if (!tokens?.refreshToken) {
      console.log(`[AccountManager] ${publicKey.slice(0, 8)}: no refresh token — needs full login`);
      return false;
    }
    try {
      const fresh = await this.runExclusive(() => browserSession.refreshAccount(tokens.refreshToken));
      this.writeTokens(publicKey, fresh);
      console.log(`[AccountManager] ${publicKey.slice(0, 8)}... refreshed`);
      return true;
    } catch (err: any) {
      console.error(`[AccountManager] Refresh failed for ${publicKey.slice(0, 8)}: ${err.message}`);
      return false;
    }
  }

  /**
   * Bulk refresh. Reuses the open browser session if one exists; otherwise
   * spins one up (which costs a CF challenge once). Returns counts only.
   */
  async refreshAccounts(
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
    let success = 0;
    if (total === 0) {
      onProgress?.(0, 0, 'No accounts selected');
      return { success, total };
    }

    let session = this.reloginSession;
    let opened = false;
    if (!session) {
      onProgress?.(0, total, 'Opening browser — complete the Cloudflare challenge...');
      session = await openBrowserSession();
      this.reloginSession = session;
      opened = true;
    }

    onProgress?.(0, total, `Refreshing ${total} account(s)...`);
    for (let i = 0; i < pool.length; i++) {
      if (this.stopRelogin) {
        onProgress?.(i, total, 'Stopped by user');
        break;
      }
      const pk = pool[i];
      onProgress?.(i, total, `Refreshing ${pk.slice(0, 8)}...`);
      const ok = await this.refreshAccount(pk, session).catch(() => false);
      if (ok) success++;
      const done = i + 1;
      onProgress?.(done, total, ok
        ? `${pk.slice(0, 8)} OK (${success}/${done})`
        : `${pk.slice(0, 8)} FAIL (${success}/${done})`);
    }

    // Leave session open if WE opened it AND viewers might use it. Caller
    // can close via stopReloginAll if they want to discard it.
    void opened;
    return { success, total };
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

  isKeepWarmRunning(): boolean {
    return this.keepWarm.running;
  }

  stopReloginAll(): void {
    this.stopRelogin = true;
    this.keepWarm.running = false;
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

  /**
   * Keep selected accounts logged in by refreshing them forever (refresh-only —
   * never a full re-login, since login has its own stricter limits). The first
   * pass refreshes every selected account that has a refresh token; later passes
   * only refresh accounts whose access token expires within `thresholdMin`.
   * Paced `delayMs` apart so it stays under the measured ~16-per-IP refresh wall
   * (≈12–14 per 31s at 2.5s spacing). On the wall it backs off ~35s; an account
   * whose refresh keeps failing is flagged dead (needs a manual re-login) and
   * skipped. Runs in the background; the returned promise resolves once the loop
   * has started. Stop with stopKeepLoggedIn() or stopReloginAll().
   */
  async startKeepLoggedIn(
    targets: string[] | undefined,
    opts: { delayMs?: number; thresholdMin?: number } = {},
    onProgress?: (message: string, running: boolean) => void,
  ): Promise<void> {
    if (this.keepWarm.running) {
      onProgress?.('Keep-logged-in already running', true);
      return;
    }
    const { openBrowserSession } = await import('../browser-auth');
    this.refreshKeys();
    this.stopRelogin = false;
    this.keepWarm.running = true;
    this.keepWarm.fails.clear();
    this.keepWarm.dead.clear();

    const delayMs = Math.max(500, Math.floor(opts.delayMs ?? 2500));
    const thresholdMs = Math.max(60_000, Math.floor((opts.thresholdMin ?? 5) * 60_000));

    const resolvePool = (): string[] => {
      this.refreshKeys();
      if (targets && targets.length > 0) return targets.filter((k) => this.keyCache.has(k));
      const selected = this.readSelection();
      return selected.size > 0
        ? [...this.keyCache.keys()].filter((k) => selected.has(k))
        : [...this.keyCache.keys()];
    };

    let session = this.reloginSession;
    if (!session) {
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

    onProgress?.('Keep-logged-in started — refreshing selected accounts...', true);

    let initial = true;
    let consecutiveFails = 0;

    // Background loop — intentionally not awaited by the caller.
    void (async () => {
      while (this.keepWarm.running) {
        const pool = resolvePool().filter((pk) => !this.keepWarm.dead.has(pk));
        const withRt = pool.filter((pk) => !!this.readTokens(pk)?.refreshToken);
        const noRt = pool.filter((pk) => !this.readTokens(pk)?.refreshToken);
        if (initial && noRt.length > 0) {
          onProgress?.(`${noRt.length} selected account(s) have no refresh token — they need a manual re-login and won't be kept warm.`, true);
        }

        const due = initial
          ? withRt
          : withRt.filter((pk) => {
              const e = this.readAccessExp(pk);
              return e == null || e - Date.now() <= thresholdMs;
            });
        initial = false;

        if (due.length === 0) {
          await this.sleepUnlessStopped(5000);
          continue;
        }

        for (const pk of due) {
          if (!this.keepWarm.running) break;
          const ok = await this.refreshAccount(pk, browser).catch(() => false);
          if (ok) {
            consecutiveFails = 0;
            this.keepWarm.fails.delete(pk);
            const e = this.readAccessExp(pk);
            const mins = e != null ? Math.max(0, Math.round((e - Date.now()) / 60000)) : 0;
            onProgress?.(`refreshed ${pk.slice(0, 8)} (good for ~${mins}m)`, true);
          } else {
            consecutiveFails++;
            const f = (this.keepWarm.fails.get(pk) ?? 0) + 1;
            this.keepWarm.fails.set(pk, f);
            if (consecutiveFails >= 2) {
              onProgress?.('Hit the refresh rate limit — backing off 35s...', true);
              await this.sleepUnlessStopped(35_000);
              consecutiveFails = 0;
            } else if (f >= 3) {
              this.keepWarm.dead.add(pk);
              onProgress?.(`${pk.slice(0, 8)} can't be refreshed (dead token) — needs manual re-login. Skipping.`, true);
            } else {
              onProgress?.(`refresh failed for ${pk.slice(0, 8)} (will retry)`, true);
            }
          }
          if (!this.keepWarm.running) break;
          await this.sleepUnlessStopped(delayMs);
        }
      }
      onProgress?.('Keep-logged-in stopped', false);
    })();
  }

  stopKeepLoggedIn(): void {
    this.keepWarm.running = false;
  }
}

export const accountManager = new AccountManager();
