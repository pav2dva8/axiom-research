import { EventEmitter } from "events";
import type { LoadedAccount } from "./account-manager";
import type { BrowserSession } from "../browser-auth";

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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function looksLikeTokenInfoData(data: any): boolean {
  if (!data || typeof data !== "object") return false;
  const pair = data.pair ?? data.pairInfo ?? data.pool ?? {};
  const token = data.token ?? data.baseToken ?? data.base_token ?? {};
  return Boolean(
    firstString(
      data.pairAddress,
      data.pair_address,
      data.poolAddress,
      data.pool_address,
      pair.pairAddress,
      pair.pair_address,
      pair.address,
      data.tokenAddress,
      data.token_address,
      data.mint,
      data.mintAddress,
      token.address,
      token.mint,
      data.ticker,
      data.tokenTicker,
      data.symbol,
      token.symbol,
      data.name,
      data.tokenName,
      token.name,
      data.protocol,
      data.dex,
      pair.protocol,
      pair.dex,
    ),
  );
}

export function normalizeTokenInfo(
  pairAddress: string,
  data: any,
  fallback: Partial<TokenInfo> = {},
): TokenInfo | null {
  const pair = data?.pair ?? data?.pairInfo ?? data?.pool ?? {};
  const token = data?.token ?? data?.baseToken ?? data?.base_token ?? {};
  const resolvedPairAddress = firstString(
    data?.pairAddress,
    data?.pair_address,
    data?.poolAddress,
    data?.pool_address,
    pair?.pairAddress,
    pair?.pair_address,
    pair?.address,
    pairAddress,
    fallback.pairAddress,
  );

  if (!resolvedPairAddress) return null;

  return {
    pairAddress: resolvedPairAddress,
    tokenAddress:
      firstString(
        data?.tokenAddress,
        data?.token_address,
        data?.mint,
        data?.mintAddress,
        data?.mint_address,
        token?.address,
        token?.mint,
        token?.mintAddress,
        fallback.tokenAddress,
      ) ?? "",
    ticker:
      firstString(
        data?.ticker,
        data?.tokenTicker,
        data?.symbol,
        token?.symbol,
        fallback.ticker,
      ) ?? "TOKEN",
    name:
      firstString(
        data?.name,
        data?.tokenName,
        data?.token_name,
        token?.name,
        fallback.name,
      ) ?? "Token",
    protocol:
      firstString(
        data?.protocol,
        data?.dex,
        data?.exchange,
        pair?.protocol,
        pair?.dex,
        fallback.protocol,
      ) ?? "Unknown",
    isMigrated:
      firstBoolean(data?.isMigrated, data?.migrated, fallback.isMigrated) ??
      false,
    supply:
      firstFiniteNumber(
        data?.supply,
        data?.totalSupply,
        data?.total_supply,
        token?.totalSupply,
        token?.total_supply,
        fallback.supply,
      ) ?? 1_000_000_000,
    price:
      firstFiniteNumber(
        data?.price,
        data?.priceUsd,
        data?.price_usd,
        token?.price,
        fallback.price,
      ) ?? 0,
  };
}

/** Anti-detection knobs. All defaults are conservative. */
export interface ConnectAllOptions {
  minGapMs?: number;
  maxGapMs?: number;
  shuffle?: boolean;
  bootstrapDisabled?: boolean;
  connectAttempts?: number;
  connectRetryMinMs?: number;
  connectRetryMaxMs?: number;
  /** Max number of viewer handshakes in flight at the same time. Default 1 (serial). */
  concurrency?: number;
}

export interface ViewerAccountGroup {
  id: number;
  label: string;
  session: BrowserSession;
  accounts: LoadedAccount[];
}

export interface ConnectGroupsOptions extends ConnectAllOptions {
  groupStartDelayMinMs?: number;
  groupStartDelayMaxMs?: number;
}

interface ViewerConnection {
  viewerId: number;
  session: BrowserSession;
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
  private connectedViewers: Map<string, ViewerConnection> = new Map();
  private warmedAccounts: Set<string> = new Set(); // publicKeys that have been bootstrapped this process
  private tokenInfo: TokenInfo | null = null;
  private bootstrapDisabled = false;
  // Halts an in-progress connectAll loop. Set by either stop mode so no new
  // viewers join once a stop has been requested.
  private connectCancelled = false;
  // Aborts an in-progress slow-stop loop. Set by force stop so it can preempt
  // a slow stop and tear everything down immediately.
  private slowStopCancelled = false;
  // True until we've done one full WS open→close cycle on this browser
  // session. The very first cluster9 WS on a freshly-opened friendsPage
  // lands in a state where the server never broadcasts back (eye-room count
  // never arrives). A throwaway open+close primes the path; the next real
  // connect works normally. Reset to true whenever a new BrowserSession is
  // attached.
  private needsClusterWarmup = true;
  private clusterWarmedSessions: WeakSet<BrowserSession> = new WeakSet();

  constructor() {
    super();
  }

  setBrowserSession(session: BrowserSession | null): void {
    this.browserSession = session;
    this.needsClusterWarmup = true;
    this.clusterWarmedSessions = new WeakSet();
  }

  getBrowserSession(): BrowserSession | null {
    return this.browserSession;
  }

  /**
   * Fallback for when the CF-bypassed browser fetch is unavailable. The
   * real client uses api9 for pair-info; we try that first.
   */
  async fetchTokenInfo(pairAddress: string): Promise<TokenInfo | null> {
    const tryHost = async (host: string): Promise<TokenInfo | null> => {
      const response = await fetch(
        `https://${host}/pair-info?pairAddress=${pairAddress}&v=${Date.now()}`,
        {
          headers: {
            Origin: "https://axiom.trade",
            Referer: "https://axiom.trade/",
          },
        },
      );
      if (!response.ok) return null;
      const data = await response.json();
      if (!looksLikeTokenInfoData(data)) return null;
      return normalizeTokenInfo(pairAddress, data);
    };
    for (const host of [
      "api9.axiom.trade",
      "api7.axiom.trade",
      "api3.axiom.trade",
      "api2.axiom.trade",
    ]) {
      try {
        const tokenInfo = await tryHost(host);
        if (tokenInfo) return tokenInfo;
      } catch {}
    }
    return null;
  }

  setTokenInfo(tokenInfo: TokenInfo): void {
    if (
      this.tokenInfo &&
      this.tokenInfo.pairAddress !== tokenInfo.pairAddress &&
      this.connectedViewers.size > 0
    ) {
      console.log(
        `[Viewer] Token changed ${this.tokenInfo.pairAddress.slice(0, 8)} → ${tokenInfo.pairAddress.slice(0, 8)}; disconnecting previous viewers`,
      );
      this.disconnectAll();
    }
    this.tokenInfo = tokenInfo;
  }

  getTokenInfo(): TokenInfo | null {
    return this.tokenInfo;
  }

  private isRetryableConnectError(err: any): boolean {
    const message = String(err?.message || err || "");
    return (
      /friends closed code=1006/i.test(message) ||
      /cluster9 closed code=1006/i.test(message) ||
      /WS timeout/i.test(message) ||
      /Unexpected response code:\s*425/i.test(message)
    );
  }

  private async connectAccount(
    account: LoadedAccount,
    slotIndex: number = 0,
    emitProgress: boolean = true,
    session: BrowserSession | null = this.browserSession,
    retry: { attempts?: number; minDelayMs?: number; maxDelayMs?: number } = {},
  ): Promise<boolean> {
    if (!this.tokenInfo || !session) {
      console.log(
        `[Viewer] ${account.publicKey.slice(0, 8)}: no ${!this.tokenInfo ? "token info" : "browser session"}`,
      );
      if (emitProgress) this.emit("viewer-failed", account.publicKey);
      return false;
    }
    if (emitProgress) this.emit("viewer-connecting", account.publicKey);

    const attempts = Math.max(1, Math.floor(retry.attempts ?? 1));
    const minDelayMs = Math.max(0, Math.floor(retry.minDelayMs ?? 0));
    const maxDelayMs = Math.max(minDelayMs, Math.floor(retry.maxDelayMs ?? minDelayMs));

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // First viewer attempt for this account in this process: fire the
        // bootstrap HTTP burst the real client does on page load. Without it
        // the server appears to skip the account when computing e-{pair}
        // viewer counts (especially for new accounts). UI checkbox toggles
        // this.bootstrapDisabled so we can A/B test whether the burst is
        // actually needed (or causing cluster9 1006 drops).
        if (
          !this.bootstrapDisabled &&
          !this.warmedAccounts.has(account.publicKey)
        ) {
          try {
            await session.bootstrapSession(
              account.publicKey,
              account.accessToken,
              account.refreshToken,
            );
            this.warmedAccounts.add(account.publicKey);
            // Tiny pause so the server commits the bootstrap before the WS
            // handshake. Real client takes ~150-300 ms between the burst and
            // joining cluster9.
            await new Promise((r) =>
              setTimeout(r, 50 + Math.floor(Math.random() * 50)),
            );
          } catch (e: any) {
            console.log(
              `[Viewer] ${account.publicKey.slice(0, 8)} bootstrap failed: ${e.message}`,
            );
            // Continue anyway — bootstrap failure shouldn't block a connect attempt.
          }
        } else if (this.bootstrapDisabled) {
          console.log(
            `[Viewer] ${account.publicKey.slice(0, 8)} bootstrap SKIPPED`,
          );
        }

        // Random ping-start jitter (0..1000 ms) so multiple viewers' 1-Hz "."
        // pings spread across the second instead of pulsing in lockstep.
        const pingJitterMs = Math.floor(Math.random() * 1000);
        const tStart = Date.now();
        const viewerId = await session.connectViewer(
          account.accessToken,
          account.refreshToken,
          this.tokenInfo,
          pingJitterMs,
          slotIndex,
        );
        console.log(
          `[Timing] slot=${slotIndex} ${account.publicKey.slice(0, 8)} connectViewer took ${Date.now() - tStart}ms`,
        );
        this.connectedViewers.set(account.publicKey, { viewerId, session });
        console.log(
          `[Viewer] ${account.publicKey.slice(0, 8)} connected as viewer ${viewerId}`,
        );
        this.emit("viewer-connected", account.publicKey);
        return true;
      } catch (err: any) {
        if (attempt < attempts && this.isRetryableConnectError(err)) {
          const delayMs = this.randomDelayMs(minDelayMs, maxDelayMs);
          console.log(
            `[Viewer] ${account.publicKey.slice(0, 8)} transient connect failure (${err.message}); retrying in ${Math.round(delayMs / 1000)}s (${attempt}/${attempts})`,
          );
          if (delayMs > 0) await this.sleep(delayMs);
          continue;
        }
        console.log(
          `[Viewer] ${account.publicKey.slice(0, 8)} failed: ${err.message}`,
        );
        if (emitProgress) this.emit("viewer-failed", account.publicKey);
        return false;
      }
    }

    return false;
  }

  private randomDelayMs(minMs: number, maxMs: number): number {
    if (maxMs <= minMs) return minMs;
    return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async warmClusterPath(session: BrowserSession, account: LoadedAccount): Promise<void> {
    if (this.clusterWarmedSessions.has(session)) return;
    this.clusterWarmedSessions.add(session);
    console.log(`[Viewer] Warming cluster9 path with ${account.publicKey.slice(0, 8)}...`);
    const ok = await this.connectAccount(account, 0, false, session).catch(() => false);
    if (ok) {
      const connection = this.connectedViewers.get(account.publicKey);
      this.connectedViewers.delete(account.publicKey);
      if (connection) {
        await connection.session.disconnectViewer(connection.viewerId).catch(() => {});
      }
      await this.sleep(300);
    }
    console.log("[Viewer] Warmup done");
  }

  async connectGroups(
    groups: ViewerAccountGroup[],
    opts: ConnectGroupsOptions = {},
  ): Promise<number> {
    const rawMin = opts.minGapMs ?? 200;
    const rawMax = opts.maxGapMs ?? 500;
    const minGap = Math.max(0, Math.floor(rawMin));
    const maxGap = Math.max(minGap, Math.floor(rawMax));
    const groupMinGap = Math.max(0, Math.floor(opts.groupStartDelayMinMs ?? 5000));
    const groupMaxGap = Math.max(groupMinGap, Math.floor(opts.groupStartDelayMaxMs ?? 15_000));
    const shouldShuffle = opts.shuffle ?? true;

    const nextBootstrapDisabled = opts.bootstrapDisabled ?? true;
    if (nextBootstrapDisabled !== this.bootstrapDisabled) {
      this.warmedAccounts.clear();
    }
    this.bootstrapDisabled = nextBootstrapDisabled;
    this.connectCancelled = false;

    let connected = 0;
    let nextGroupStartOffsetMs = 0;

    const workers = groups
      .filter((group) => group.accounts.length > 0)
      .map((group, groupIndex) => {
        const startDelayMs = nextGroupStartOffsetMs;
        nextGroupStartOffsetMs += this.randomDelayMs(groupMinGap, groupMaxGap);
        return (async () => {
          if (startDelayMs > 0) await this.sleep(startDelayMs);
          if (this.connectCancelled) return;

          const order = shouldShuffle ? shuffle(group.accounts) : [...group.accounts];
          const retry = {
            attempts: opts.connectAttempts ?? 3,
            minDelayMs: opts.connectRetryMinMs ?? 15_000,
            maxDelayMs: opts.connectRetryMaxMs ?? 30_000,
          };

          for (const account of order) {
            if (this.connectCancelled) return;
            const gap = this.randomDelayMs(minGap, maxGap);
            if (gap > 0) await this.sleep(gap);
            if (this.connectCancelled) return;
            const success = await this.connectAccount(account, 0, true, group.session, retry);
            if (!success) continue;
            if (this.connectCancelled) {
              const connection = this.connectedViewers.get(account.publicKey);
              this.connectedViewers.delete(account.publicKey);
              if (connection) {
                await connection.session.disconnectViewer(connection.viewerId).catch(() => {});
              }
              this.emit("viewer-disconnected", account.publicKey);
              return;
            }
            connected++;
          }
        })();
      });

    await Promise.all(workers);
    return connected;
  }

  /**
   * Connect each account in shuffled order, with a random gap between starts
   * (default 0.2–0.5s) so all accounts don't slam the WS handshake at once.
   */
  async connectAll(
    accounts: LoadedAccount[],
    opts: ConnectAllOptions = {},
  ): Promise<number> {
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
    this.connectCancelled = false;

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
      const warmAccount = order.find(
        (a) => !this.connectedViewers.has(a.publicKey),
      );
      if (warmAccount) {
        console.log(
          `[Viewer] Warming cluster9 path with ${warmAccount.publicKey.slice(0, 8)}...`,
        );
        const ok = await this.connectAccount(warmAccount, 0, false).catch(
          () => false,
        );
        if (ok) {
          const connection = this.connectedViewers.get(warmAccount.publicKey);
          this.connectedViewers.delete(warmAccount.publicKey);
          if (connection) {
            await connection.session.disconnectViewer(connection.viewerId).catch(() => {});
          }
          // Small gap so cluster9 sees the close before we reopen.
          await new Promise((r) => setTimeout(r, 300));
        }
        console.log("[Viewer] Warmup done");
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
        if (this.connectCancelled) return;
        const account = claim();
        if (!account) return;
        const gap =
          minGap + Math.floor(Math.random() * Math.max(1, maxGap - minGap));
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
        if (this.connectCancelled) return;
        const success = await this.connectAccount(account, slotIndex);
        if (!success) continue;
        // A stop landed while this handshake was still in flight. The browser
        // disconnectAll already ran (or will), so this freshly-joined viewer
        // would linger — tear it down explicitly and stop.
        if (this.connectCancelled) {
          const connection = this.connectedViewers.get(account.publicKey);
          this.connectedViewers.delete(account.publicKey);
          if (connection) {
            await connection.session.disconnectViewer(connection.viewerId).catch(() => {});
          }
          this.emit("viewer-disconnected", account.publicKey);
          return;
        }
        connected++;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
    return connected;
  }

  /** Force stop: halt connecting, abort any slow stop, drop everyone now. */
  disconnectAll(): void {
    this.connectCancelled = true;
    this.slowStopCancelled = true;
    const sessions = new Set<BrowserSession>();
    for (const connection of this.connectedViewers.values()) {
      sessions.add(connection.session);
    }
    if (sessions.size === 0 && this.browserSession) {
      sessions.add(this.browserSession);
    }
    for (const session of sessions) {
      session.disconnectAllViewers().catch(() => {});
    }
    this.connectedViewers.clear();
    // Re-bootstrap on next Start in case the server expired the warm-up.
    this.warmedAccounts.clear();
  }

  /**
   * Slow stop: disconnect one viewer at a time (~delayMs apart). Halts the
   * connect loop first so no new viewers join mid-teardown. Preemptable by
   * disconnectAll() (force stop), which flips slowStopCancelled.
   */
  async disconnectSlowly(delayMs = 2000): Promise<number> {
    this.connectCancelled = true;
    this.slowStopCancelled = false;
    const gap = Math.max(0, Math.floor(delayMs));
    let disconnected = 0;

    while (this.connectedViewers.size > 0 && !this.slowStopCancelled) {
      const entry = this.connectedViewers.entries().next().value;
      if (!entry) break;
      const [publicKey, connection] = entry;
      try {
        await connection.session.disconnectViewer(connection.viewerId);
      } catch {}
      this.connectedViewers.delete(publicKey);
      this.emit("viewer-disconnected", publicKey);
      disconnected++;

      if (
        this.connectedViewers.size > 0 &&
        !this.slowStopCancelled &&
        gap > 0
      ) {
        await new Promise((r) => setTimeout(r, gap));
      }
    }

    if (this.connectedViewers.size === 0) {
      this.warmedAccounts.clear();
    }
    return disconnected;
  }

  getActiveCount(): number {
    return this.connectedViewers.size;
  }

  isAccountConnected(publicKey: string): boolean {
    return this.connectedViewers.has(publicKey);
  }
}

export const viewerService = new ViewerService();
