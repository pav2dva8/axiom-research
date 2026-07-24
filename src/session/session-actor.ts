import { FeedPool, type FeedToken } from "./feed-pool";
import { pageUpdateDiscover, pageUpdatePulse } from "./page-update";
import {
  planEnterFromFeed,
  planLeaveAll,
  planTokenToToken,
  type NavAction,
  type NavTokenRef,
} from "./token-navigation-plan";
import {
  pickDelayMs,
  resolveWarmupTiming,
  type ResolvedWarmupTiming,
  type WarmupTiming,
} from "./warmup-timing";

export type SessionMode = "warmup" | "deploy";

export interface SessionBridge {
  openSession(access: string, refresh: string, opts?: unknown): Promise<number>;
  navigateSession(id: number, actions: NavAction[]): Promise<void>;
  closeSession(id: number): Promise<void>;
}

export interface TokenInfo extends NavTokenRef {
  [key: string]: unknown;
}

export type SessionState = {
  mode: SessionMode;
  sessionId?: number;
  currentToken?: TokenInfo | FeedToken;
};

export type SessionStateEvent = "state";

type StateListener = (state: SessionState) => void;

const SOCKET_DEAD_RE =
  /cluster socket is not open|friends socket is not open|session .+ is not open|session closed|friends closed|cluster\d*\.?axiom\.trade closed|WS timeout/i;

const MAX_CONSECUTIVE_REOPENS = 3;
const MAX_OPEN_ATTEMPTS = 3;

function isSocketDeadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return SOCKET_DEAD_RE.test(message);
}

export class SessionActor {
  private readonly publicKey: string;
  private readonly bridge: SessionBridge;
  private readonly feed: FeedPool;
  private readonly timing: ResolvedWarmupTiming;
  private readonly listeners = new Set<StateListener>();

  private sessionId: number | null = null;
  private mode: SessionMode = "warmup";
  private currentToken: TokenInfo | FeedToken | null = null;
  private closed = false;
  private warmupGeneration = 0;
  private loopPromise: Promise<void> | null = null;
  private navInFlight: Promise<void> = Promise.resolve();
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private openOpts: unknown = undefined;
  private consecutiveReopens = 0;

  constructor(opts: {
    publicKey: string;
    bridge: SessionBridge;
    feed: FeedPool;
    timing?: WarmupTiming;
    onState?: StateListener;
  }) {
    this.publicKey = opts.publicKey;
    this.bridge = opts.bridge;
    this.feed = opts.feed;
    this.timing = resolveWarmupTiming(opts.timing);
    if (opts.onState) this.listeners.add(opts.onState);
  }

  on(event: SessionStateEvent, cb: StateListener): () => void {
    if (event !== "state") throw new Error(`Unsupported SessionActor event: ${event}`);
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async startWarmup(access: unknown, refresh: unknown, openOpts: unknown): Promise<void> {
    this.accessToken = access as string;
    this.refreshToken = refresh as string;
    this.openOpts = openOpts;

    if (this.sessionId === null) {
      this.sessionId = await this.bridge.openSession(
        this.accessToken,
        this.refreshToken,
        openOpts,
      );
    }

    this.closed = false;
    this.mode = "warmup";
    this.consecutiveReopens = 0;
    this.emitState();
    this.startWarmupLoop();
  }

  async gotoDeploy(token: TokenInfo): Promise<void> {
    const sessionId = this.requireSession();
    this.stopWarmupLoop();
    await this.navInFlight;

    const actions = this.currentToken
      ? planTokenToToken(this.currentToken, token, this.timing.rng)
      : planEnterFromFeed(token, this.timing.rng);

    await this.navigate(sessionId, actions);
    this.currentToken = token;
    this.mode = "deploy";
    this.emitState();
  }

  async returnToWarmup(): Promise<void> {
    const sessionId = this.requireSession();
    this.stopWarmupLoop();
    await this.navInFlight;

    if (this.currentToken) {
      await this.navigate(sessionId, [
        ...planLeaveAll(this.currentToken),
        this.contextPageUpdateAction(),
      ]);
      this.currentToken = null;
    } else {
      await this.navigate(sessionId, [this.contextPageUpdateAction()]);
    }

    this.mode = "warmup";
    this.emitState();
    this.startWarmupLoop();
  }

  async forceClose(): Promise<void> {
    const sessionId = this.sessionId;
    this.stopWarmupLoop();
    await this.navInFlight;

    if (sessionId !== null) {
      await this.bridge.closeSession(sessionId);
      this.sessionId = null;
    }

    this.closed = true;
    this.currentToken = null;
    this.emitState();
  }

  getMode(): SessionMode {
    return this.mode;
  }

  private startWarmupLoop(): void {
    const generation = ++this.warmupGeneration;
    this.loopPromise = this.runWarmupLoop(generation);
    this.loopPromise.catch(() => {
      // Keep background warmup failures from becoming unhandled rejections.
    });
  }

  private stopWarmupLoop(): void {
    this.warmupGeneration++;
  }

  private async runWarmupLoop(generation: number): Promise<void> {
    while (this.isWarmupActive(generation)) {
      try {
        const contextNav = await this.navigateWarmup(generation, [
          this.contextPageUpdateAction(),
        ]);
        if (!this.isWarmupActive(generation)) return;
        if (contextNav === "reopened") continue;

        await this.waitFor(this.timing.contextGapMs);
        if (!this.isWarmupActive(generation)) return;

        await this.feed.refresh().catch(() => {});
        if (!this.isWarmupActive(generation)) return;

        const next = this.feed.pickRandom(this.timing.rng);
        if (next) {
          const actions = this.currentToken
            ? planTokenToToken(this.currentToken, next, this.timing.rng)
            : planEnterFromFeed(next, this.timing.rng);
          const tokenNav = await this.navigateWarmup(generation, actions);
          if (!this.isWarmupActive(generation)) return;
          if (tokenNav === "reopened") continue;
          this.currentToken = next;
          this.emitState();
        }

        await this.waitFor(this.timing.dwellMs);
      } catch (err) {
        if (!this.isWarmupActive(generation)) return;
        console.warn(
          `[SessionActor] ${this.publicKey.slice(0, 8)} warmup stopped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await this.forceClose().catch(() => {});
        return;
      }
    }
  }

  private async navigateWarmup(
    generation: number,
    actions: NavAction[],
  ): Promise<"ok" | "reopened"> {
    const sessionId = this.requireSession();
    try {
      await this.navigate(sessionId, actions);
      this.consecutiveReopens = 0;
      return "ok";
    } catch (err) {
      if (!isSocketDeadError(err) || !this.isWarmupActive(generation)) throw err;
      this.consecutiveReopens += 1;
      if (this.consecutiveReopens > MAX_CONSECUTIVE_REOPENS) {
        throw new Error(
          `warmup reconnect exhausted after ${MAX_CONSECUTIVE_REOPENS} consecutive socket deaths`,
        );
      }
      console.warn(
        `[SessionActor] ${this.publicKey.slice(0, 8)} socket dead during warmup; reopening (${this.consecutiveReopens}/${MAX_CONSECUTIVE_REOPENS})`,
      );
      await this.reopenSession();
      return "reopened";
    }
  }

  private async reopenSession(): Promise<number> {
    if (this.accessToken == null || this.refreshToken == null) {
      throw new Error("SessionActor cannot reopen without stored credentials");
    }

    const oldSessionId = this.sessionId;
    // Drop the dead id before reopen so a failed open does not leave a stale
    // sessionId that forceClose would try to close again.
    this.sessionId = null;
    this.currentToken = null;
    if (oldSessionId !== null) {
      await this.bridge.closeSession(oldSessionId).catch(() => {});
    }

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS; attempt++) {
      try {
        // Rooms were on the dead socket — resume from Discover/Pulse, not mid-token.
        this.sessionId = await this.bridge.openSession(
          this.accessToken,
          this.refreshToken,
          this.openOpts,
        );
        this.emitState();
        return this.sessionId;
      } catch (err) {
        lastErr = err;
        if (!isSocketDeadError(err) || attempt >= MAX_OPEN_ATTEMPTS) break;
        console.warn(
          `[SessionActor] ${this.publicKey.slice(0, 8)} reopen handshake failed (${attempt}/${MAX_OPEN_ATTEMPTS}): ${
            err instanceof Error ? err.message : String(err)
          }; retrying`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr ?? "reopenSession failed"));
  }

  private isWarmupActive(generation: number): boolean {
    return !this.closed && this.mode === "warmup" && this.warmupGeneration === generation;
  }

  private async navigate(sessionId: number, actions: NavAction[]): Promise<void> {
    const nav = this.navInFlight.then(() => this.bridge.navigateSession(sessionId, actions));
    this.navInFlight = nav.catch(() => undefined);
    await nav;
  }

  private async waitFor(delay: ResolvedWarmupTiming["contextGapMs"]): Promise<void> {
    await this.timing.wait(pickDelayMs(delay, this.timing.rng));
  }

  private contextPageUpdateAction(): NavAction {
    const pageUpdate = this.timing.rng() < 0.5 ? pageUpdateDiscover() : pageUpdatePulse();
    return { atMs: 0, ws: "friends", op: "pageUpdate", pageUpdate };
  }

  private requireSession(): number {
    if (this.sessionId === null) throw new Error("SessionActor has not started a session");
    return this.sessionId;
  }

  private emitState(): void {
    const state: SessionState = {
      mode: this.mode,
      ...(this.sessionId !== null ? { sessionId: this.sessionId } : {}),
      ...(this.currentToken ? { currentToken: this.currentToken } : {}),
    };
    for (const listener of this.listeners) listener(state);
  }
}
