import { EventEmitter } from 'events';
import type { LoadedAccount } from './account-manager';
import type { BrowserSession } from '../browser-auth';

export interface TokenInfo {
  pairAddress: string;
  tokenAddress: string;
  ticker: string;
  name: string;
  protocol: string;
  isMigrated: boolean;
  supply: number;
  price: number;
}

/** Anti-detection knobs. All defaults are conservative. */
export interface ConnectAllOptions {
  minGapMs?: number;
  maxGapMs?: number;
  shuffle?: boolean;
  bootstrapDisabled?: boolean;
  /** Max number of viewer handshakes in flight at the same time. Default 1 (serial). */
  concurrency?: number;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class ViewerService extends EventEmitter {
  private browserSession: BrowserSession | null = null;
  private connectedViewers: Map<string, number> = new Map(); // publicKey -> browser viewer id
  private warmedAccounts: Set<string> = new Set(); // publicKeys that have been bootstrapped this process
  private tokenInfo: TokenInfo | null = null;
  private bootstrapDisabled = false;
  // True until we've done one full WS open→close cycle on this browser
  // session. The very first cluster9 WS on a freshly-opened friendsPage
  // lands in a state where the server never broadcasts back (eye-room count
  // never arrives). A throwaway open+close primes the path; the next real
  // connect works normally. Reset to true whenever a new BrowserSession is
  // attached.
  private needsClusterWarmup = true;

  constructor() {
    super();
  }

  setBrowserSession(session: BrowserSession | null): void {
    this.browserSession = session;
    this.needsClusterWarmup = true;
  }

  getBrowserSession(): BrowserSession | null {
    return this.browserSession;
  }

  /**
   * Fallback for when the CF-bypassed browser fetch is unavailable. The
   * real client uses api9 for pair-info; we try that first.
   */
  async fetchTokenInfo(pairAddress: string): Promise<TokenInfo | null> {
    const tryHost = async (host: string) => {
      const response = await fetch(
        `https://${host}/pair-info?pairAddress=${pairAddress}&v=${Date.now()}`,
        { headers: { 'Origin': 'https://axiom.trade', 'Referer': 'https://axiom.trade/' } },
      );
      if (!response.ok) return null;
      return await response.json() as any;
    };
    let data: any = null;
    try { data = await tryHost('api9.axiom.trade'); } catch {}
    if (!data) { try { data = await tryHost('api2.axiom.trade'); } catch {} }
    if (!data) return null;
    return {
      pairAddress,
      tokenAddress: data.tokenAddress || data.baseToken?.address || '',
      ticker: data.ticker || data.baseToken?.symbol || 'UNKNOWN',
      name: data.name || data.baseToken?.name || 'Unknown Token',
      protocol: data.protocol || 'Pump V1',
      isMigrated: data.isMigrated || false,
      supply: data.supply || data.baseToken?.totalSupply || 1000000000,
      price: data.price || data.priceUsd || 0,
    };
  }

  setTokenInfo(tokenInfo: TokenInfo): void {
    this.tokenInfo = tokenInfo;
  }

  getTokenInfo(): TokenInfo | null {
    return this.tokenInfo;
  }

  private async connectAccount(account: LoadedAccount, slotIndex: number = 0, emitProgress: boolean = true): Promise<boolean> {
    if (!this.tokenInfo || !this.browserSession) {
      console.log(`[Viewer] ${account.publicKey.slice(0, 8)}: no ${!this.tokenInfo ? 'token info' : 'browser session'}`);
      if (emitProgress) this.emit('viewer-failed', account.publicKey);
      return false;
    }
    if (emitProgress) this.emit('viewer-connecting', account.publicKey);
    try {
      // First viewer attempt for this account in this process: fire the
      // bootstrap HTTP burst the real client does on page load. Without it
      // the server appears to skip the account when computing e-{pair}
      // viewer counts (especially for new accounts). UI checkbox toggles
      // this.bootstrapDisabled so we can A/B test whether the burst is
      // actually needed (or causing cluster9 1006 drops).
      if (!this.bootstrapDisabled && !this.warmedAccounts.has(account.publicKey)) {
        try {
          await this.browserSession.bootstrapSession(
            account.publicKey,
            account.accessToken,
            account.refreshToken,
          );
          this.warmedAccounts.add(account.publicKey);
          // Tiny pause so the server commits the bootstrap before the WS
          // handshake. Real client takes ~150-300 ms between the burst and
          // joining cluster9.
          await new Promise(r => setTimeout(r, 50 + Math.floor(Math.random() * 50)));
        } catch (e: any) {
          console.log(`[Viewer] ${account.publicKey.slice(0, 8)} bootstrap failed: ${e.message}`);
          // Continue anyway — bootstrap failure shouldn't block a connect attempt.
        }
      } else if (this.bootstrapDisabled) {
        console.log(`[Viewer] ${account.publicKey.slice(0, 8)} bootstrap SKIPPED (UI toggle)`);
      }

      // Random ping-start jitter (0..1000 ms) so multiple viewers' 1-Hz "."
      // pings spread across the second instead of pulsing in lockstep.
      const pingJitterMs = Math.floor(Math.random() * 1000);
      const tStart = Date.now();
      const viewerId = await this.browserSession.connectViewer(
        account.accessToken,
        account.refreshToken,
        this.tokenInfo,
        pingJitterMs,
        slotIndex,
      );
      console.log(`[Timing] slot=${slotIndex} ${account.publicKey.slice(0, 8)} connectViewer took ${Date.now() - tStart}ms`);
      this.connectedViewers.set(account.publicKey, viewerId);
      console.log(`[Viewer] ${account.publicKey.slice(0, 8)} connected as viewer ${viewerId}`);
      this.emit('viewer-connected', account.publicKey);
      return true;
    } catch (err: any) {
      console.log(`[Viewer] ${account.publicKey.slice(0, 8)} failed: ${err.message}`);
      if (emitProgress) this.emit('viewer-failed', account.publicKey);
      return false;
    }
  }

  /**
   * Connect each account in shuffled order, with a random gap between starts
   * (default 0.2–0.5s) so all accounts don't slam the WS handshake at once.
   */
  async connectAll(accounts: LoadedAccount[], opts: ConnectAllOptions = {}): Promise<number> {
    const rawMin = opts.minGapMs ?? 200;
    const rawMax = opts.maxGapMs ?? 500;
    const minGap = Math.max(0, Math.floor(rawMin));
    const maxGap = Math.max(minGap, Math.floor(rawMax));
    const shouldShuffle = opts.shuffle ?? true;
    const order = shouldShuffle ? shuffle(accounts) : [...accounts];
    // Toggling the bootstrap flag invalidates prior warm-up, so re-bootstrap
    // (or skip) every account on this run.
    const nextBootstrapDisabled = opts.bootstrapDisabled ?? false;
    if (nextBootstrapDisabled !== this.bootstrapDisabled) {
      this.warmedAccounts.clear();
    }
    this.bootstrapDisabled = nextBootstrapDisabled;

    const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
    // Pre-grow the friendsPage pool so each worker gets its own page.
    // Without this, evaluates serialize on a single page and concurrency
    // does nothing (measured empirically).
    if (this.browserSession) {
      await this.browserSession.ensurePageSlots(concurrency);
    }

    // First run on this browser session: do a throwaway connect+disconnect
    // with the first account so the cluster9 WS path is primed. Otherwise
    // the very first real viewer joins silently — server never broadcasts
    // the eye-room count back. Mirrors the user's manual stop+start workaround.
    if (this.needsClusterWarmup && this.browserSession && order.length > 0) {
      this.needsClusterWarmup = false;
      const warmAccount = order.find(a => !this.connectedViewers.has(a.publicKey));
      if (warmAccount) {
        console.log(`[Viewer] Warming cluster9 path with ${warmAccount.publicKey.slice(0, 8)}...`);
        const ok = await this.connectAccount(warmAccount, 0, false).catch(() => false);
        if (ok) {
          const id = this.connectedViewers.get(warmAccount.publicKey);
          this.connectedViewers.delete(warmAccount.publicKey);
          if (id != null) {
            await this.browserSession.disconnectViewer(id).catch(() => {});
          }
          // Small gap so cluster9 sees the close before we reopen.
          await new Promise(r => setTimeout(r, 300));
        }
        console.log('[Viewer] Warmup done');
      }
    }

    let connected = 0;
    let nextIndex = 0;
    const claim = (): LoadedAccount | null => {
      while (nextIndex < order.length) {
        const a = order[nextIndex++];
        if (!this.connectedViewers.has(a.publicKey)) return a;
      }
      return null;
    };
    const worker = async (slotIndex: number) => {
      while (true) {
        const account = claim();
        if (!account) return;
        const gap = minGap + Math.floor(Math.random() * Math.max(1, maxGap - minGap));
        if (gap > 0) await new Promise(r => setTimeout(r, gap));
        const success = await this.connectAccount(account, slotIndex);
        if (success) connected++;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
    return connected;
  }

  disconnectAll(): void {
    if (this.browserSession) {
      this.browserSession.disconnectAllViewers().catch(() => {});
    }
    this.connectedViewers.clear();
    // Re-bootstrap on next Start in case the server expired the warm-up.
    this.warmedAccounts.clear();
  }

  getActiveCount(): number {
    return this.connectedViewers.size;
  }

  isAccountConnected(publicKey: string): boolean {
    return this.connectedViewers.has(publicKey);
  }
}

export const viewerService = new ViewerService();
