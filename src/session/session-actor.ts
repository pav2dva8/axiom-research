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
    if (this.sessionId === null) {
      this.sessionId = await this.bridge.openSession(access as string, refresh as string, openOpts);
    }

    this.closed = false;
    this.mode = "warmup";
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
    const sessionId = this.requireSession();
    const generation = ++this.warmupGeneration;
    this.loopPromise = this.runWarmupLoop(sessionId, generation);
    this.loopPromise.catch(() => {
      // Keep background warmup failures from becoming unhandled rejections.
    });
  }

  private stopWarmupLoop(): void {
    this.warmupGeneration++;
  }

  private async runWarmupLoop(sessionId: number, generation: number): Promise<void> {
    while (this.isWarmupActive(generation)) {
      await this.navigate(sessionId, [this.contextPageUpdateAction()]);
      if (!this.isWarmupActive(generation)) return;

      await this.waitFor(this.timing.contextGapMs);
      if (!this.isWarmupActive(generation)) return;

      const next = this.feed.pickRandom(this.timing.rng);
      if (next) {
        const actions = this.currentToken
          ? planTokenToToken(this.currentToken, next, this.timing.rng)
          : planEnterFromFeed(next, this.timing.rng);
        await this.navigate(sessionId, actions);
        if (!this.isWarmupActive(generation)) return;
        this.currentToken = next;
        this.emitState();
      }

      await this.waitFor(this.timing.dwellMs);
    }
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
