/**
 * Browser-based Cloudflare bypass.
 * Launches a real Chrome via command line with remote debugging,
 * connects via CDP. API calls are made from the browser context
 * so CF cookies are automatically included.
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import type { AuthTokens, WalletInfo } from './auth';
import { buildSignMessage } from './auth';
import type { NavAction } from './session/token-navigation-plan';
import { planEnterFromFeed } from './session/token-navigation-plan';
import { pageUpdateMeme } from './session/page-update';

/**
 * Viewer-manager script installed on every page in the context via
 * `addInitScript`. Exposes:
 *   - __openSession(id, opts) → number (sync)
 *       Synchronously constructs the discovered cluster + friends WebSocket pair so
 *       cookies are captured at the moment of construction. Stores a Promise
 *       in `__pendingPromises[id]` that resolves when both handshakes open.
 *   - __openSessionAwait(id) → Promise<number>
 *       Returns the stored Promise so the caller can await handshake
 *       completion separately (without holding the cookie lock).
 *   - __navigateSession(id, actions), __closeSession(id), __disconnectAll(), __activeCount()
 *   - __connectViewerStart / __connectViewerAwait compatibility shim for the
 *       old burst-on-connect path while callers migrate to open+navigate.
 *
 * Why split start/await? Cookies live on the BrowserContext (global). If
 * worker A is mid-handshake while worker B sets account-B cookies, A's
 * handshake would pick up B's identity. Splitting lets us release the
 * cookie lock the instant `new WebSocket()` has captured cookies.
 *
 * Written with `function` declarations (not arrows) so esbuild/tsx don't
 * wrap nested arrows with `__name(...)` (we shim it anyway, but plain
 * functions are simpler when the body is stringified).
 */
const VIEWER_MANAGER_SCRIPT = `
(function() {
  if (typeof window === 'undefined' || window.__viewerManagerInstalled) return;
  window.__viewerManagerInstalled = true;
  window.__viewers = {};
  window.__pendingPromises = {};

  var FRIENDS_URL = 'wss://friends.axiom.trade/ws';

  function clearSessionTimers(v) {
    if (!v) return;
    clearTimeout(v.friendsPingStart);
    clearInterval(v.friendsPingTimer);
    clearInterval(v.clusterPingTimer);
    for (var i = 0; i < v.timers.length; i++) clearTimeout(v.timers[i]);
    v.timers = [];
  }

  function closeSockets(v) {
    if (!v) return;
    try { v.clusterWs.close(); } catch (_) {}
    try { v.friendsWs.close(); } catch (_) {}
  }

  function cleanupSession(id, close) {
    var v = window.__viewers[id];
    if (!v) return;
    v.closed = true;
    clearSessionTimers(v);
    if (v.navReject) {
      try { v.navReject(new Error('session closed')); } catch (_) {}
      v.navReject = null;
    }
    if (close) closeSockets(v);
    delete window.__viewers[id];
  }

  function waitFor(v, ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise(function(resolve, reject) {
      if (v.closed) return reject(new Error('session closed'));
      var timer = setTimeout(function() {
        var idx = v.timers.indexOf(timer);
        if (idx >= 0) v.timers.splice(idx, 1);
        v.navReject = null;
        if (v.closed) reject(new Error('session closed'));
        else resolve();
      }, ms);
      v.timers.push(timer);
      v.navReject = function(err) {
        clearTimeout(timer);
        reject(err);
      };
    });
  }

  function normalizePageUpdate(payload) {
    payload = payload || {};
    if (payload.type === 'pageUpdate') return payload;
    var out = {
      type: 'pageUpdate',
      page: payload.page || 'meme',
      chain: payload.chain || 'sol'
    };
    if (payload.subpage !== undefined) out.subpage = payload.subpage;
    return out;
  }

  function sendNavAction(id, action) {
    var v = window.__viewers[id];
    if (!v || v.closed) throw new Error('session ' + id + ' is not open');
    if (!action || typeof action !== 'object') throw new Error('invalid nav action');

    if (action.ws === 'cluster') {
      if (v.clusterWs.readyState !== 1) throw new Error('cluster socket is not open');
      if ((action.op !== 'join' && action.op !== 'leave') || !action.room) {
        throw new Error('invalid cluster nav action');
      }
      v.clusterWs.send(JSON.stringify({ action: action.op, room: action.room }));
      if (action.op === 'join') v.currentRooms.add(action.room);
      else v.currentRooms.delete(action.room);
      return;
    }

    if (action.ws === 'friends' && action.op === 'pageUpdate') {
      if (v.friendsWs.readyState !== 1) throw new Error('friends socket is not open');
      v.friendsWs.send(JSON.stringify(normalizePageUpdate(action.pageUpdate)));
      return;
    }

    throw new Error('unsupported nav action');
  }

  function buildCompatEnterPlan(tokenInfo) {
    tokenInfo = tokenInfo || {};
    var pairAddress = tokenInfo.pairAddress || '';
    var tokenAddress = tokenInfo.tokenAddress || '';
    var lateAt = 450;
    var roomsEarly = ['t:' + pairAddress, 'f:' + pairAddress, pairAddress + '_refresh'];
    var roomsLate = [
      'e-' + pairAddress,
      'td:' + pairAddress,
      's:' + pairAddress,
      pairAddress + '-dex-paid',
      pairAddress + '-wallet_funding',
      'kol_tx:' + pairAddress,
      'pump-cto:' + pairAddress,
      'a:' + tokenAddress,
      'soc_bub:' + tokenAddress,
      'b-' + pairAddress
    ];
    var actions = [];
    for (var i = 0; i < roomsEarly.length; i++) {
      actions.push({ atMs: 0, ws: 'cluster', op: 'join', room: roomsEarly[i] });
    }
    for (var j = 0; j < roomsLate.length; j++) {
      actions.push({ atMs: lateAt, ws: 'cluster', op: 'join', room: roomsLate[j] });
    }
    actions.push({ atMs: lateAt, ws: 'friends', op: 'pageUpdate', pageUpdate: {
      type: 'pageUpdate',
      page: 'meme',
      subpage: tokenInfo,
      chain: 'sol'
    } });
    return actions;
  }

  window.__openSession = function(id, opts) {
    opts = opts || {};
    var pingJitterMs = typeof opts.pingJitterMs === 'number' ? opts.pingJitterMs : Math.floor(Math.random() * 1000);
    var clusterUrl = (typeof opts.clusterUrl === 'string' && opts.clusterUrl)
      ? opts.clusterUrl
      : (window.__axiomClusterUrl || 'wss://cluster8.axiom.trade/');
    var clusterLabel = String(clusterUrl).split('/')[2] || 'cluster';

    var resolveFn, rejectFn;
    var promise = new Promise(function(res, rej) { resolveFn = res; rejectFn = rej; });
    window.__pendingPromises[id] = promise;

    var clusterWs = new WebSocket(clusterUrl);
    var friendsWs = new WebSocket(FRIENDS_URL);
    var timeout = setTimeout(function() { fail('WS timeout'); }, 12000);

    var clusterOpen = false, friendsOpen = false;
    var settled = false;
    var friendsPingTimer = 0, clusterPingTimer = 0, friendsPingStart = 0;
    var tStart = Date.now();

    function killBoth() {
      try { clusterWs.close(); } catch (_) {}
      try { friendsWs.close(); } catch (_) {}
    }
    function fail(why) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killBoth();
      rejectFn(new Error(why));
    }
    function tryResolve() {
      if (!clusterOpen || !friendsOpen || settled) return;
      settled = true;
      clearTimeout(timeout);

      friendsPingStart = setTimeout(function() {
        friendsPingTimer = setInterval(function() {
          if (friendsWs.readyState === 1) friendsWs.send('.');
          else clearInterval(friendsPingTimer);
        }, 1000);
      }, pingJitterMs);

      clusterPingTimer = setInterval(function() {
        if (clusterWs.readyState === 1) clusterWs.send(JSON.stringify({ method: 'ping' }));
        else clearInterval(clusterPingTimer);
      }, 30000 + Math.floor(Math.random() * 5000));

      window.__viewers[id] = {
        clusterWs: clusterWs, friendsWs: friendsWs,
        friendsPingTimer: friendsPingTimer, clusterPingTimer: clusterPingTimer, friendsPingStart: friendsPingStart,
        currentRooms: new Set(),
        timers: [],
        closed: false,
        navReject: null
      };
      resolveFn(id);
    }

    clusterWs.onopen = function() {
      console.log('[viewer ' + id + '] ' + clusterLabel + ' open');
      clusterOpen = true;
      tryResolve();
    };
    clusterWs.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (typeof msg.room === 'string' && msg.room.indexOf('e-') === 0) {
          console.log('[viewer ' + id + '] eye-room count = ' + msg.content);
        }
      } catch (_) {}
    };
    clusterWs.onerror = function() {
      console.log('[viewer ' + id + '] ' + clusterLabel + ' error event');
    };
    clusterWs.onclose = function(e) {
      var dt = Date.now() - tStart;
      console.log('[viewer ' + id + '] ' + clusterLabel + ' closed code=' + e.code + ' clean=' + e.wasClean + ' reason="' + (e.reason || '') + '" after ' + dt + 'ms');
      cleanupSession(id, false);
      if (!settled) fail(clusterLabel + ' closed code=' + e.code + (e.reason ? ' reason=' + e.reason : ''));
    };

    friendsWs.onopen = function() {
      friendsOpen = true;
      tryResolve();
    };
    friendsWs.onmessage = function(e) {
      if (e.data === '.') return;
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'ping') friendsWs.send(JSON.stringify({ type: 'pong' }));
      } catch (_) {}
    };
    friendsWs.onerror = function() {
      console.log('[viewer ' + id + '] friends error event');
    };
    friendsWs.onclose = function(e) {
      var dt = Date.now() - tStart;
      console.log('[viewer ' + id + '] friends closed code=' + e.code + ' clean=' + e.wasClean + ' reason="' + (e.reason || '') + '" after ' + dt + 'ms');
      cleanupSession(id, false);
      if (!settled) fail('friends closed code=' + e.code + (e.reason ? ' reason=' + e.reason : ''));
    };

    return id;
  };

  window.__openSessionAwait = function(id) {
    var p = window.__pendingPromises[id];
    delete window.__pendingPromises[id];
    return p;
  };

  window.__navigateSession = function(id, actions) {
    var v = window.__viewers[id];
    if (!v || v.closed) return Promise.reject(new Error('session ' + id + ' is not open'));
    actions = (actions || []).slice().sort(function(a, b) { return (a.atMs || 0) - (b.atMs || 0); });
    var start = Date.now();
    return (async function() {
      for (var i = 0; i < actions.length; i++) {
        var action = actions[i];
        var delayMs = Math.max(0, start + Math.max(0, action.atMs || 0) - Date.now());
        await waitFor(v, delayMs);
        sendNavAction(id, action);
      }
    })();
  };

  window.__closeSession = function(id) {
    cleanupSession(id, true);
  };

  window.__disconnectViewer = function(id) {
    window.__closeSession(id);
  };

  window.__disconnectAll = function() {
    var keys = Object.keys(window.__viewers);
    for (var i = 0; i < keys.length; i++) {
      window.__closeSession(keys[i]);
    }
  };

  window.__activeCount = function() {
    var vals = Object.keys(window.__viewers).map(function(k) { return window.__viewers[k]; });
    return vals.filter(function(v) { return v.clusterWs.readyState === 1; }).length;
  };

  window.__connectViewerStart = function(id, tokenInfo, opts) {
    window.__openSession(id, opts || {});
    var openPromise = window.__pendingPromises[id];
    window.__pendingPromises[id] = openPromise.then(function(openId) {
      return window.__navigateSession(openId, buildCompatEnterPlan(tokenInfo)).then(function() {
        return openId;
      });
    });
    return id;
  };

  window.__connectViewerAwait = function(id) {
    return window.__openSessionAwait(id);
  };
})();
`;

const TURNSTILE_SITEKEY = '0x4AAAAAACb1mthF4yHVUfUh';
// Axiom shards its API across apiN.axiom.trade hosts. Do not prefer a fixed
// shard: probe which ones are healthy for this browser/proxy session and use
// that. These lists are only the probe/fallback namespace.
export const API_SHARD_PROBE_HOSTS = [
  'api2.axiom.trade',
  'api3.axiom.trade',
  'api4.axiom.trade',
  'api5.axiom.trade',
  'api6.axiom.trade',
  'api7.axiom.trade',
  'api8.axiom.trade',
  'api9.axiom.trade',
  'api10.axiom.trade',
] as const;

/** Fallback namespace when session probe has not picked an apiN yet (no preferred shard). */
export const LOGIN_API_HOSTS = API_SHARD_PROBE_HOSTS;
export const AXIOM_BROWSER_PAGE_URL = 'https://axiom.trade/terms?chain=sol';
const DEBUG_PORT = 9222;

export interface BrowserSession {
  loginAccount(wallet: WalletInfo): Promise<AuthTokens>;
  /** Same as loginAccount but with allowRegistration: true (fresh wallet signup). */
  signupAccount(wallet: WalletInfo): Promise<AuthTokens>;
  getCfData(): Promise<{ cfCookies: string; userAgent: string }>;
  fetchPairInfo(pairAddress: string): Promise<any | null>;
  fetchMemeTrending(): Promise<unknown>;
  resolvePairFromCa(ca: string, accessToken?: string, refreshToken?: string): Promise<any | null>;
  /**
   * Run the session bootstrap that the real client fires on every page load
   * (user-data, lighthouse, get-settings, ...). Without this the server
   * appears to skip new accounts when computing the e-{pair} viewer count
   * even though the account is otherwise logged in.
   */
  bootstrapSession(walletAddress: string, accessToken: string, refreshToken: string): Promise<void>;
  /** Discovered apiN + clusterN for this browser/proxy session (after observe). */
  getSessionShards(): SessionShards;
  /** Run portfolio/discover observe once (lazy — skipped at session open). */
  ensureSessionShards(): Promise<SessionShards>;
  probeEucalyptus(pairAddress: string, accessToken?: string, refreshToken?: string): Promise<void>;
  /**
   * Refresh the access token via Axiom's /refresh-access-token endpoint.
   * Returns new AuthTokens (the refresh token may rotate too). Much faster
   * than a full login since it doesn't need Turnstile or wallet signing.
   */
  refreshAccount(refreshToken: string): Promise<AuthTokens>;
  /** Grow the friendsPage pool to at least `n` pages so workers can run in parallel. */
  ensurePageSlots(n: number): Promise<void>;
  openSession(accessToken: string, refreshToken: string, opts?: BrowserSessionOpenOptions): Promise<number>;
  navigateSession(sessionId: number, actions: NavAction[]): Promise<void>;
  closeSession(sessionId: number): Promise<void>;
  connectViewer(accessToken: string, refreshToken: string, tokenInfo: any, pingJitterMs?: number, slotIndex?: number): Promise<number>;
  disconnectViewer(viewerId: number): Promise<void>;
  disconnectAllViewers(): Promise<void>;
  getActiveViewerCount(): Promise<number>;
  close(): Promise<void>;
}

export interface BrowserSessionOpenOptions {
  pingJitterMs?: number;
  slotIndex?: number;
}

export interface BrowserProxyConfig {
  server: string;
  username?: string;
  password?: string;
  label?: string;
}

export interface BrowserWindowOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  startMinimized?: boolean;
  anchor?: 'bottom-right';
  marginX?: number;
  marginY?: number;
}

interface NormalizedBrowserWindowOptions {
  width: number;
  height: number;
  x: number;
  y: number;
  startMinimized: boolean;
  anchor?: 'bottom-right';
  marginX: number;
  marginY: number;
}

const DEFAULT_BROWSER_WINDOW: NormalizedBrowserWindowOptions = {
  width: 800,
  height: 600,
  x: 100,
  y: 100,
  startMinimized: false,
  marginX: 24,
  marginY: 48,
};

export const PROXY_BACKGROUND_BROWSER_WINDOW: BrowserWindowOptions = {
  width: 480,
  height: 360,
  x: 1200,
  y: 700,
  startMinimized: false,
  anchor: 'bottom-right',
  marginX: 24,
  marginY: 48,
};

export const MANUAL_CHALLENGE_BROWSER_WINDOW: BrowserWindowOptions = {
  width: 900,
  height: 700,
  x: 80,
  y: 80,
  startMinimized: false,
};

export interface BrowserSessionOptions {
  proxy?: BrowserProxyConfig;
  debugPort?: number;
  killExistingDebugPort?: boolean;
  label?: string;
  window?: BrowserWindowOptions;
  minimizeAfterReady?: boolean;
  surfaceOnCloudflareChallenge?: boolean;
  challengeWindow?: BrowserWindowOptions;
  onCloudflareChallenge?: (message: string) => void;
}

export function buildChromeProxyArgs(proxy?: BrowserProxyConfig): string[] {
  if (!proxy?.server) return [];
  return [`--proxy-server=${proxy.server}`];
}

export function buildProxyKeepWarmBrowserSessionOptions(
  proxy: BrowserProxyConfig,
  label: string,
  onCloudflareChallenge?: (message: string) => void,
): BrowserSessionOptions {
  return {
    proxy,
    label,
    killExistingDebugPort: false,
    window: PROXY_BACKGROUND_BROWSER_WINDOW,
    minimizeAfterReady: true,
    surfaceOnCloudflareChallenge: true,
    onCloudflareChallenge,
  };
}

function normalizeBrowserWindowOptions(browserWindow?: BrowserWindowOptions): NormalizedBrowserWindowOptions {
  const anchor = browserWindow?.anchor;
  return {
    width: Math.max(100, Math.floor(browserWindow?.width ?? DEFAULT_BROWSER_WINDOW.width)),
    height: Math.max(100, Math.floor(browserWindow?.height ?? DEFAULT_BROWSER_WINDOW.height)),
    x: Math.floor(browserWindow?.x ?? DEFAULT_BROWSER_WINDOW.x),
    y: Math.floor(browserWindow?.y ?? DEFAULT_BROWSER_WINDOW.y),
    startMinimized: browserWindow?.startMinimized ?? DEFAULT_BROWSER_WINDOW.startMinimized,
    anchor,
    marginX: Math.max(0, Math.floor(browserWindow?.marginX ?? DEFAULT_BROWSER_WINDOW.marginX)),
    marginY: Math.max(0, Math.floor(browserWindow?.marginY ?? DEFAULT_BROWSER_WINDOW.marginY)),
  };
}

export function buildChromeWindowArgs(browserWindow?: BrowserWindowOptions): string[] {
  const normalized = normalizeBrowserWindowOptions(browserWindow);
  const args = [
    `--window-size=${normalized.width},${normalized.height}`,
    `--window-position=${normalized.x},${normalized.y}`,
  ];
  if (normalized.startMinimized) args.push('--start-minimized');
  return args;
}

async function resolveBrowserWindowBounds(
  page: Page,
  browserWindow: BrowserWindowOptions | undefined,
): Promise<NormalizedBrowserWindowOptions> {
  const normalized = normalizeBrowserWindowOptions(browserWindow);
  if (normalized.anchor !== 'bottom-right') return normalized;

  const screenSize = await page.evaluate(() => {
    const screen = (globalThis as any).screen || {};
    return {
      width: screen.availWidth || screen.width || 0,
      height: screen.availHeight || screen.height || 0,
    };
  }).catch(() => null);

  if (!screenSize?.width || !screenSize?.height) return normalized;

  return {
    ...normalized,
    x: Math.max(0, screenSize.width - normalized.width - normalized.marginX),
    y: Math.max(0, screenSize.height - normalized.height - normalized.marginY),
  };
}

async function applyBrowserWindowOptions(
  context: BrowserContext,
  page: Page,
  browserWindow: BrowserWindowOptions | undefined,
  opts: { forceNormal?: boolean } = {},
): Promise<void> {
  const normalized = await resolveBrowserWindowBounds(page, browserWindow);
  const cdp = await context.newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' },
    }).catch(() => {});
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        left: normalized.x,
        top: normalized.y,
        width: normalized.width,
        height: normalized.height,
      },
    });
    if (normalized.startMinimized && !opts.forceNormal) {
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      }).catch(() => {});
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function minimizeBrowserWindow(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export function isRefreshResponseSuccessful(resultOk: boolean, realStatus: number): boolean {
  return resultOk || (realStatus >= 200 && realStatus < 300);
}

export function isLoginHostRetryableStatus(status: number): boolean {
  return (
    status === 0 ||
    status === 404 ||
    status === 408 ||
    status === 417 ||
    status === 418 ||
    status === 429 ||
    status >= 500
  );
}

export function isCloudflareChallengePage(url: string, html: string): boolean {
  if (/\/cdn-cgi\/|challenge/i.test(url)) return true;
  return /cf-browser-verification|cf-challenge|verify you are human|checking if the site connection is secure|checking your browser|перевірка безпеки|підтверд(?:ьте|іть).*людин|ви не бот/i.test(html);
}

function isLoginHostRetryableError(stage: string, status: number): boolean {
  if (stage === 'verify' && (status === 429 || status >= 500)) return false;
  return isLoginHostRetryableStatus(status);
}

interface LoginVerifyPayload {
  walletAddress: string;
  allowLinking: false;
  allowRegistration: boolean;
  forAddCredential: false;
  isVerify: false;
  nonce: string;
  referrer: null;
  signature: string;
  turnstileToken: string;
  v: number;
}

export interface RunLoginApiHostVerificationOptions {
  hosts: readonly string[];
  walletPublicKey: string;
  /** Fresh-account signup when true; existing-account login when false/omitted. */
  allowRegistration?: boolean;
  getNonce(host: string, walletPublicKey: string): Promise<string>;
  signNonce(nonce: string): string;
  getTurnstileToken(): Promise<string>;
  verify(host: string, payload: LoginVerifyPayload): Promise<void>;
  onHostFailure?(host: string, status: number, message: string): void | Promise<void>;
}

export async function runLoginApiHostVerification(
  opts: RunLoginApiHostVerificationOptions,
): Promise<{ host: string; nonce: string }> {
  let lastHostErr: any;

  const apiStageError = (host: string, stage: string, err: any) => {
    err.status = typeof err?.status === 'number' ? err.status : 0;
    err.host = host;
    err.stage = stage;
    return err;
  };

  for (const host of opts.hosts) {
    try {
      await opts.getNonce(host, opts.walletPublicKey)
        .catch((err) => { throw apiStageError(host, 'nonce', err); });
      const turnstileToken = await opts.getTurnstileToken();
      const nonce = await opts.getNonce(host, opts.walletPublicKey)
        .catch((err) => { throw apiStageError(host, 'nonce', err); });
      const signature = opts.signNonce(nonce);
      await opts.verify(host, {
        walletAddress: opts.walletPublicKey,
        allowLinking: false,
        allowRegistration: opts.allowRegistration === true,
        forAddCredential: false,
        isVerify: false,
        nonce,
        referrer: null,
        signature,
        turnstileToken,
        v: Date.now(),
      }).catch((err) => { throw apiStageError(host, 'verify', err); });
      return { host, nonce };
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : null;
      const stage = typeof err?.stage === 'string' ? err.stage : '';
      if (status == null || !isLoginHostRetryableError(stage, status)) throw err;

      lastHostErr = err;
      await opts.onHostFailure?.(host, status, String(err?.message || err));
    }
  }

  throw lastHostErr || new Error('Login failed: no login API hosts tried');
}

/** Fallback namespace only — session probe picks the live shard first. */
export const REFRESH_ACCESS_TOKEN_HOSTS = API_SHARD_PROBE_HOSTS;

/** Default cluster WS when CDP discovery has not observed one yet. */
export const DEFAULT_CLUSTER_WS_URL = 'wss://cluster8.axiom.trade/';

/**
 * Fallback pages if /terms does not emit apiN + clusterN (rare).
 * Primary discovery is CDP on AXIOM_BROWSER_PAGE_URL — terms opens both.
 */
export const AXIOM_SHARD_DISCOVERY_URL = 'https://axiom.trade/portfolio?chain=sol';
export const AXIOM_SHARD_DISCOVERY_FALLBACK_URL = 'https://axiom.trade/discover?chain=sol';

const AXIOM_API_HOST_RE = /^api\d+\.axiom\.trade$/i;
const AXIOM_CLUSTER_HOST_RE = /^cluster\d+\.axiom\.trade$/i;

export interface SessionShards {
  apiHost: string | null;
  clusterWsUrl: string;
}

export function parseAxiomApiHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return AXIOM_API_HOST_RE.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function normalizeClusterWsUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export function parseAxiomClusterWsUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
    const host = u.hostname.toLowerCase();
    if (!AXIOM_CLUSTER_HOST_RE.test(host)) return null;
    return normalizeClusterWsUrl(`wss://${host}/`);
  } catch {
    return null;
  }
}

export function clusterHostFromWsUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function preferApiHosts(
  discovered: string | null | undefined,
  fallbacks: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const host of [discovered, ...fallbacks]) {
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/** Pick one healthy apiN for this session (randomized so proxy groups diversify). */
export function chooseDiscoveredApiHost(
  healthyHosts: readonly string[],
  random: () => number = Math.random,
): string | null {
  if (healthyHosts.length === 0) return null;
  const idx = Math.min(healthyHosts.length - 1, Math.max(0, Math.floor(random() * healthyHosts.length)));
  return healthyHosts[idx] ?? null;
}

/** Login/refresh host order: discovered first, then remaining probe hosts (stable unique). */
export function apiHostsForLoginOrRefresh(
  discovered: string | null | undefined,
  fallbacks: readonly string[] = API_SHARD_PROBE_HOSTS,
): string[] {
  return preferApiHosts(discovered ?? null, fallbacks);
}

export function buildAuthCookieDomains(clusterWsUrl?: string | null): string[] {
  const clusterHost =
    clusterHostFromWsUrl(clusterWsUrl || DEFAULT_CLUSTER_WS_URL) ||
    clusterHostFromWsUrl(DEFAULT_CLUSTER_WS_URL)!;
  return [clusterHost, 'friends.axiom.trade', '.axiom.trade'];
}

function findChrome(): string {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Chrome not found. Install Google Chrome.');
}

async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port < start + 200; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
    if (available) return port;
  }
  throw new Error(`No available Chrome debug port found near ${start}`);
}

export async function openBrowserSession(options: BrowserSessionOptions = {}): Promise<BrowserSession> {
  const label = options.label || options.proxy?.label || '';
  const logPrefix = label ? `[BrowserAuth:${label}]` : '[BrowserAuth]';
  console.log(`${logPrefix} Launching real Chrome${options.proxy ? ' with proxy' : ''}...`);

  const debugPort = options.debugPort ?? (options.proxy ? await findAvailablePort(DEBUG_PORT + 1) : DEBUG_PORT);
  const shouldKillDebugPort = options.killExistingDebugPort ?? !options.proxy;

  // Kill any leftover Chrome on the debug port before spawning a new one
  if (shouldKillDebugPort) {
    try {
      const { execSync } = await import('child_process');
      execSync(`lsof -ti :${debugPort} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 500));
    } catch {}
  }

  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-chrome-'));
  const chromePath = findChrome();

  const chromeProc: ChildProcess = spawn(chromePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${tmpProfile}`,
    ...buildChromeProxyArgs(options.proxy),
    '--no-first-run',
    '--no-default-browser-check',
    ...buildChromeWindowArgs(options.window),
    'about:blank',
  ], {
    stdio: 'ignore',
    detached: false,
  });

  await new Promise(r => setTimeout(r, 2000));

  // Force IPv4 — Node 22's DNS prefers ::1 but Chrome's --remote-debugging-port
  // binds to 127.0.0.1 only. Retry a few times in case Chrome is still warming
  // up (cold launches on macOS can take a few seconds).
  const cdpUrl = `http://127.0.0.1:${debugPort}`;
  let browser: Browser | null = null;
  let cdpErr: any;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      break;
    } catch (err: any) {
      cdpErr = err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  if (!browser) {
    chromeProc.kill();
    throw new Error(`Failed to connect to Chrome at ${cdpUrl}: ${cdpErr?.message}`);
  }

  console.log(`${logPrefix} Connected to Chrome via CDP`);

  const context: BrowserContext = browser.contexts()[0];
  const page: Page = context.pages()[0] || await context.newPage();
  let browserReadyForMinimize = false;
  if (options.window) {
    await applyBrowserWindowOptions(context, page, options.window).catch((err: any) => {
      console.warn(`${logPrefix} Could not apply Chrome window placement: ${err?.message || err}`);
    });
  }

  async function parkReadyBrowserWindow(): Promise<void> {
    if (!options.window) return;
    await applyBrowserWindowOptions(context, page, options.window).catch((err: any) => {
      console.warn(`${logPrefix} Could not restore Chrome window placement: ${err?.message || err}`);
    });
    if (options.minimizeAfterReady) {
      await minimizeBrowserWindow(context, page).catch((err: any) => {
        console.warn(`${logPrefix} Could not minimize Chrome window: ${err?.message || err}`);
      });
    }
  }

  async function attachProxyAuthToPage(p: Page): Promise<void> {
    const proxy = options.proxy;
    if (!proxy?.username) return;
    const cdp = await context.newCDPSession(p);
    await cdp.send('Fetch.enable', { handleAuthRequests: true });
    cdp.on('Fetch.authRequired', async ({ requestId }: any) => {
      await cdp.send('Fetch.continueWithAuth', {
        requestId,
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: proxy.username,
          password: proxy.password || '',
        },
      }).catch(() => {});
    });
    cdp.on('Fetch.requestPaused', async ({ requestId }: any) => {
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    });
  }

  await attachProxyAuthToPage(page);

  // Keep Chrome light: these pages only need the axiom.trade origin, cookies,
  // Turnstile, and the SDK-patched XHR layer. Video/media from the landing page
  // burns CPU/GPU and is not needed for auth or WS handshakes.
  await context.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    if (req.resourceType() === 'media' || /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(url)) {
      return route.abort();
    }
    return route.continue();
  }).catch(() => {});

  // Navigate to a lightweight axiom.trade page for Cloudflare/Turnstile.
  await page.goto(AXIOM_BROWSER_PAGE_URL, { waitUntil: 'load', timeout: 30000 });
  console.log(`${logPrefix} Page loaded, URL:`, page.url());

  // ── Cloudflare / Turnstile readiness helpers ───────────────────────────
  // The main axiom.trade page is the same-origin browser surface under
  // Cloudflare's *managed* challenge. The app or CF can navigate it at any
  // moment, which destroys the JS execution context of any in-flight
  // page.evaluate — including the long-lived Turnstile token render. These
  // helpers let us detect that, wait it out, and re-prime Turnstile before
  // each login attempt.

  async function mainPageChallengeState(): Promise<{ onChallenge: boolean; visibleChallenge: boolean }> {
    try {
      const html = await page.content();
      const onChallenge = isCloudflareChallengePage(page.url(), html);
      return { onChallenge, visibleChallenge: onChallenge };
    } catch {
      // content()/url() can throw if a navigation is in flight. Treat it as
      // not ready, but don't surface the browser as if manual CF input is needed.
      return { onChallenge: true, visibleChallenge: false };
    }
  }

  // Is the main page currently sitting on a Cloudflare interstitial?
  async function mainPageOnChallenge(): Promise<boolean> {
    return (await mainPageChallengeState()).onChallenge;
  }

  // Wait out a CF challenge on the main page (auto-pass or manual solve, up to 2m).
  async function waitForMainPageClear(): Promise<void> {
    console.log(`${logPrefix} Cloudflare challenge on main page — waiting for it to clear (auto or manual)...`);
    const deadline = Date.now() + 120000;
    const surfaceAfter = Date.now() + 5000;
    let nextLogAt = Date.now() + 15000;
    let surfaced = false;

    const surfaceForManualSolve = async (): Promise<void> => {
      if (surfaced || !options.surfaceOnCloudflareChallenge) return;
      surfaced = true;
      const message = `${label || 'browser'} Cloudflare check needs manual solve — bringing browser to front`;
      options.onCloudflareChallenge?.(message);
      console.log(`${logPrefix} ${message}`);
      await applyBrowserWindowOptions(
        context,
        page,
        options.challengeWindow ?? MANUAL_CHALLENGE_BROWSER_WINDOW,
        { forceNormal: true },
      ).catch((err: any) => {
        console.warn(`${logPrefix} Could not surface Chrome window: ${err?.message || err}`);
      });
      await page.bringToFront().catch(() => {});
    };

    const restoreBackgroundWindow = async (): Promise<void> => {
      if (!surfaced || !options.window) return;
      if (browserReadyForMinimize) {
        await parkReadyBrowserWindow();
        return;
      }
      await applyBrowserWindowOptions(context, page, options.window).catch((err: any) => {
        console.warn(`${logPrefix} Could not restore Chrome window placement: ${err?.message || err}`);
      });
    };

    while (Date.now() < deadline) {
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
      const challengeState = await mainPageChallengeState();
      if (!challengeState.onChallenge) {
        console.log(`${logPrefix} Cloudflare challenge passed`);
        await restoreBackgroundWindow();
        return;
      }
      if (Date.now() >= surfaceAfter && challengeState.visibleChallenge) await surfaceForManualSolve();
      if (Date.now() >= nextLogAt) {
        console.log(`${logPrefix} Still waiting for Cloudflare challenge to clear...`);
        nextLogAt = Date.now() + 15000;
      }
      await page.waitForTimeout(1000);
    }

    throw new Error('Cloudflare challenge did not clear within 120s');
  }

  // (Re-)inject the Turnstile container + API script. Idempotent: a navigation
  // wipes both, so this is safe to call again before every login attempt.
  async function injectTurnstile(): Promise<void> {
    await page.evaluate(`(() => {
      if (!document.getElementById('__ts_container')) {
        const div = document.createElement('div');
        div.id = '__ts_container';
        div.style.position = 'fixed';
        div.style.bottom = '0';
        div.style.right = '0';
        div.style.zIndex = '99999';
        document.body.appendChild(div);
      }
      if (typeof window.turnstile === 'undefined' && !document.getElementById('__ts_script')) {
        const script = document.createElement('script');
        script.id = '__ts_script';
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        document.head.appendChild(script);
      }
    })()`);
    await page.waitForFunction('typeof window.turnstile !== "undefined"', null, { timeout: 15000 })
      .catch(() => { throw new Error('Failed to load Turnstile API script'); });
  }

  // Pre-flight before each login attempt: clear any CF re-challenge and make
  // sure Turnstile is loaded on the main page.
  async function ensureMainPageReady(): Promise<void> {
    if (await mainPageOnChallenge()) {
      await waitForMainPageClear();
    }
    await injectTurnstile();
  }

  // Issue an authenticated API POST from the real axiom.trade page to an API
  // shard, via XMLHttpRequest. We deliberately use this page — not a bare api
  // page — for two things /verify-wallet-v2 depends on:
  //   1. Origin/Referer become https://axiom.trade. Browsers forbid setting
  //      those headers from JS, so the request must *originate* from that page.
  //   2. Axiom's anti-bot SDK hooks XMLHttpRequest on this page and stamps its
  //      per-request headers (Xa<rand>-A..Z); a fetch from a bare page gets none.
  // XHR (not fetch) because the frontend uses axios/XHR — the layer the SDK patches.
  async function apiPostFromPage(host: string, pathName: string, bodyJson: string): Promise<{ status: number; body: string }> {
    const url = `https://${host}${pathName}`;
    return page.evaluate(`
      new Promise((resolve, reject) => {
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('POST', ${JSON.stringify(url)}, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.timeout = 20000;
          xhr.onload = function () { resolve({ status: xhr.status, body: xhr.responseText }); };
          xhr.onerror = function () { reject(new Error('XHR network error')); };
          xhr.ontimeout = function () { reject(new Error('XHR timeout')); };
          xhr.send(${JSON.stringify(bodyJson)});
        } catch (e) { reject(e); }
      })
    `) as Promise<{ status: number; body: string }>;
  }

  // Initial readiness on session open.
  if (await mainPageOnChallenge()) {
    await waitForMainPageClear();
  } else {
    console.log(`${logPrefix} No CF challenge — page loaded directly`);
  }
  await page.waitForTimeout(3000);
  console.log(`${logPrefix} Current URL:`, page.url());
  await injectTurnstile();
  console.log(`${logPrefix} Turnstile API loaded`);

  // Probe what Axiom's own JS sends — must pass auth tokens so the page loads as a real user
  async function probeEucalyptusMessages(pairAddress: string, accessToken?: string, refreshToken?: string): Promise<void> {
    if (accessToken) {
      await context.addCookies([
        { name: 'auth-access-token', value: accessToken, domain: '.axiom.trade', path: '/' },
        { name: 'auth-refresh-token', value: refreshToken || '', domain: '.axiom.trade', path: '/' },
      ]);
    }
    const probePage = await context.newPage();
    probePage.on('websocket', ws => {
      const tag = ws.url().includes('eucalyptus') ? 'eucalyptus' : ws.url().includes('friends') ? 'friends' : null;
      if (!tag) return;
      console.log(`[Probe] ${tag} WS opened`);
      ws.on('framesent', frame => console.log(`[Probe] ${tag} SENT:`, frame.payload));
      ws.on('framereceived', frame => console.log(`[Probe] ${tag} RECEIVED:`, frame.payload));
      ws.on('close', () => console.log(`[Probe] ${tag} WS closed`));
    });
    console.log('[Probe] navigating to token page as authenticated user...');
    await probePage.goto(`https://axiom.trade/meme/${pairAddress}?chain=sol`, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await probePage.waitForTimeout(60000); // watch 60s to capture pings
    await probePage.close();
    if (accessToken) {
      await context.clearCookies({ name: 'auth-access-token' });
      await context.clearCookies({ name: 'auth-refresh-token' });
    }
    console.log('[Probe] done');
  }

  // Shim esbuild/tsx helpers (`__name`, `__publicField`) in every page.
  // Functions passed to page.evaluate are stringified, and tsx wraps nested
  // `const x = (...) => ...` arrows with `__name(x, "x")` to preserve
  // Function.name. Without this shim those calls throw `ReferenceError:
  // __name is not defined` in the browser context. Passed as raw script
  // content so esbuild doesn't transform the shim itself.
  await context.addInitScript({
    content: `
      if (typeof globalThis.__name !== 'function') {
        globalThis.__name = function (fn) { return fn; };
      }
      if (typeof globalThis.__publicField !== 'function') {
        globalThis.__publicField = function (obj, key, value) { obj[key] = value; return value; };
      }
    `,
  });
  // Viewer manager auto-installs on every page navigation in this context.
  await context.addInitScript({ content: VIEWER_MANAGER_SCRIPT });

  // Page pool for WS viewer handshakes. Playwright/Chrome serializes
  // page.evaluate calls on the same page — a single shared page is the
  // throughput chokepoint at any concurrency > 1. Multiple pages let
  // evaluates run truly in parallel.
  //
  // Pool grows lazily via ensurePageSlots(n). Cookies are still on the
  // shared BrowserContext, so the addCookies → start → clearCookies
  // critical section is serialized by a tiny in-process mutex (~10-30ms).
  // After WS objects are constructed (synchronous), cookies are captured
  // and the lock is released.
  const wsUrlByReq = new Map<string, string>();
  let observedApiHost: string | null = null;
  let observedClusterWsUrl: string | null = null;
  let sessionShards: SessionShards = {
    apiHost: null,
    clusterWsUrl: DEFAULT_CLUSTER_WS_URL,
  };

  function noteNetworkUrl(url: string | undefined): void {
    if (!url) return;
    if (!observedApiHost) {
      const apiHost = parseAxiomApiHost(url);
      if (apiHost) observedApiHost = apiHost;
    }
    if (!observedClusterWsUrl) {
      const clusterWs = parseAxiomClusterWsUrl(url);
      if (clusterWs) observedClusterWsUrl = clusterWs;
    }
  }

  function tag(reqId: string): string {
    const u = wsUrlByReq.get(reqId) || reqId;
    const cluster = parseAxiomClusterWsUrl(u);
    if (cluster) return clusterHostFromWsUrl(cluster) || 'cluster';
    if (u.includes('friends')) return 'friends';
    return u;
  }

  // CDP-observed outcome of the most recent /refresh-access-token request. The
  // browser sees the REAL HTTP status + failure reason even when the in-page
  // fetch can only report status 0 (e.g. a 429/CF response with no CORS headers,
  // or a connection the rate-limiter reset). refreshAccount reads this to learn
  // what's actually behind an opaque fetch error. Refreshes are serial, so a
  // single slot is enough.
  const refreshReqIds = new Set<string>();
  let lastRefreshNetwork: { status: number | null; statusText: string; failed: boolean; error: string | null; ts: number } | null = null;

  async function attachCdpListenersTo(p: Page): Promise<void> {
    const cdp = await context.newCDPSession(p);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', ({ requestId, request }: any) => {
      if (request?.url?.includes('refresh-access-token')) refreshReqIds.add(requestId);
      noteNetworkUrl(request?.url);
    });
    cdp.on('Network.responseReceived', ({ requestId, response }: any) => {
      if (refreshReqIds.has(requestId)) {
        lastRefreshNetwork = { status: response?.status ?? null, statusText: response?.statusText ?? '', failed: false, error: null, ts: Date.now() };
      }
      noteNetworkUrl(response?.url);
    });
    cdp.on('Network.loadingFailed', ({ requestId, errorText, blockedReason, corsErrorStatus }: any) => {
      if (refreshReqIds.has(requestId)) {
        const cors = corsErrorStatus?.corsError ? `cors:${corsErrorStatus.corsError}` : null;
        lastRefreshNetwork = { status: null, statusText: '', failed: true, error: errorText || blockedReason || cors || 'unknown', ts: Date.now() };
        refreshReqIds.delete(requestId);
      }
    });
    cdp.on('Network.loadingFinished', ({ requestId }: any) => { refreshReqIds.delete(requestId); });
    cdp.on('Network.webSocketCreated', ({ requestId, url }: any) => {
      wsUrlByReq.set(requestId, url);
      noteNetworkUrl(url);
    });
    cdp.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }: any) => {
      const status = response?.status;
      const statusText = response?.statusText;
      if (status !== 101) {
        console.log(`[CDP] ${tag(requestId)} handshake ${status} ${statusText || ''}`);
      }
    });
    cdp.on('Network.webSocketFrameSent', ({ requestId, response }) => {
      if (response.payloadData) console.log(`[CDP→${tag(requestId)}]`, response.payloadData.slice(0, 300));
    });
    cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      if (response.payloadData) console.log(`[CDP←${tag(requestId)}]`, response.payloadData.slice(0, 300));
    });
    cdp.on('Network.webSocketFrameError', ({ requestId, errorMessage }: any) => {
      const msg = String(errorMessage || '');
      // Portfolio/discover without auth cookies retries clusterN and floods this.
      if (/HTTP Authentication failed/i.test(msg)) return;
      console.log(`[CDP] ${tag(requestId)} frame error: ${errorMessage}`);
    });
    cdp.on('Network.webSocketClosed', ({ requestId }) => {
      const label = tag(requestId);
      // Ignore unauthenticated cluster reconnect churn after shard discovery.
      if (!/^cluster\d+/i.test(label)) {
        console.log(`[CDP] ${label} closed`);
      }
      wsUrlByReq.delete(requestId);
    });
  }

  async function setupFriendsPage(): Promise<Page> {
    const p = await context.newPage();
    await attachProxyAuthToPage(p);
    p.on('console', msg => {
      const t = msg.text();
      if (t.startsWith('[viewer ') || t.startsWith('[viewer]')) console.log('[Browser]', t);
    });
    // CDP before goto so the first /terms load's apiN + clusterN are observed.
    await attachCdpListenersTo(p);
    await p.goto(AXIOM_BROWSER_PAGE_URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(500);
    return p;
  }

  async function applyClusterUrlToPages(clusterWsUrl: string): Promise<void> {
    await Promise.all(
      friendsPages.map((p) =>
        p.evaluate((url) => {
          (globalThis as any).__axiomClusterUrl = url;
        }, clusterWsUrl).catch(() => {}),
      ),
    );
  }

  function apiHostsForSession(extraFallbacks: readonly string[] = []): string[] {
    return apiHostsForLoginOrRefresh(sessionShards.apiHost, [
      ...API_SHARD_PROBE_HOSTS,
      ...extraFallbacks,
    ]);
  }

  async function waitForObservedShards(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (observedApiHost && observedClusterWsUrl) return;
      await friendsPage.waitForTimeout(250);
    }
  }

  function commitSessionShards(source: string): void {
    sessionShards = {
      apiHost: observedApiHost || sessionShards.apiHost,
      clusterWsUrl: observedClusterWsUrl || sessionShards.clusterWsUrl || DEFAULT_CLUSTER_WS_URL,
    };
    shardsDiscovered = !!(sessionShards.apiHost && observedClusterWsUrl);
    console.log(
      `${logPrefix} Session shards (${source}) api=${sessionShards.apiHost || 'unobserved'} cluster=${sessionShards.clusterWsUrl}`,
    );
  }

  /** CDP on /terms — live SPA hits apiN + opens clusterN (confirmed on terms?chain=sol). */
  async function discoverShardsFromTerms(): Promise<void> {
    console.log(`${logPrefix} Observing shards via ${AXIOM_BROWSER_PAGE_URL}...`);
    await waitForObservedShards(10000);
    commitSessionShards('terms');
    if (sessionShards.apiHost && observedClusterWsUrl) {
      await applyClusterUrlToPages(sessionShards.clusterWsUrl);
      return;
    }
    console.warn(
      `${logPrefix} Terms did not emit full shards (api=${observedApiHost || '-'} cluster=${observedClusterWsUrl || '-'}); will fallback if viewers need them`,
    );
    if (observedClusterWsUrl) await applyClusterUrlToPages(sessionShards.clusterWsUrl);
  }

  /** Portfolio/discover only if terms missed apiN or clusterN. */
  async function discoverSessionShardsFallback(): Promise<void> {
    const pages = [AXIOM_SHARD_DISCOVERY_URL, AXIOM_SHARD_DISCOVERY_FALLBACK_URL];
    for (let i = 0; i < pages.length; i++) {
      const url = pages[i];
      if (observedApiHost && observedClusterWsUrl) break;
      console.log(`${logPrefix} Observing shards via ${url}...`);
      await friendsPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((err: any) => {
        console.warn(`${logPrefix} shard discovery navigation failed: ${err?.message || err}`);
      });
      await waitForObservedShards(i === 0 ? 12000 : 8000);
      if (observedClusterWsUrl && observedApiHost) break;
    }

    commitSessionShards('portfolio/discover fallback');
    await applyClusterUrlToPages(sessionShards.clusterWsUrl);

    // Leave portfolio/discover so unauthenticated cluster reconnect spam stops.
    await friendsPage.goto(AXIOM_BROWSER_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }

  let shardsDiscovered = false;
  let shardDiscoveryPromise: Promise<void> | null = null;
  async function ensureSessionShards(): Promise<SessionShards> {
    if (shardsDiscovered && sessionShards.apiHost && observedClusterWsUrl) return sessionShards;
    if (!shardDiscoveryPromise) {
      shardDiscoveryPromise = (async () => {
        if (!(observedApiHost && observedClusterWsUrl)) {
          await discoverSessionShardsFallback();
        } else {
          commitSessionShards('cached');
          await applyClusterUrlToPages(sessionShards.clusterWsUrl);
        }
      })().catch((err) => {
        shardsDiscovered = true;
        sessionShards = {
          apiHost: observedApiHost || sessionShards.apiHost,
          clusterWsUrl: observedClusterWsUrl || DEFAULT_CLUSTER_WS_URL,
        };
        console.warn(
          `${logPrefix} Shard discovery failed (${err?.message || err}); using ${sessionShards.clusterWsUrl}`,
        );
      });
    }
    await shardDiscoveryPromise;
    return sessionShards;
  }

  const friendsPages: Page[] = [];
  friendsPages.push(await setupFriendsPage());
  const friendsPage = friendsPages[0]; // primary for non-pool operations (resolvePairFromCa, bootstrapSession)
  // /terms?chain=sol already emits apiN + clusterN — observe via CDP (no portfolio).
  await discoverShardsFromTerms();
  console.log(`${logPrefix} Axiom page ready`);
  browserReadyForMinimize = true;
  await parkReadyBrowserWindow();

  async function ensurePageSlots(n: number): Promise<void> {
    while (friendsPages.length < n) {
      const p = await setupFriendsPage();
      friendsPages.push(p);
      await p.evaluate((url) => {
        (globalThis as any).__axiomClusterUrl = url;
      }, sessionShards.clusterWsUrl).catch(() => {});
      console.log(`[BrowserAuth] friendsPage pool grew to ${friendsPages.length}`);
    }
  }

  // Global cookie mutex (promise-chain). Held only across:
  //   addCookies → page.evaluate('__connectViewerStart(...)') → clearCookies
  // Total ~10-30ms. Handshake (~700ms) runs outside the lock.
  let cookieChain: Promise<void> = Promise.resolve();
  function withCookieLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = cookieChain;
    let release!: () => void;
    cookieChain = new Promise<void>(r => { release = r; });
    return prev.then(async () => {
      try { return await fn(); }
      finally { release(); }
    });
  }

  // Track which page each viewer was created on, so disconnect routes correctly.
  const viewerToPage = new Map<number, Page>();
  let nextViewerId = 0;

  // Viewer manager is auto-installed on every page via context.addInitScript
  // (see VIEWER_MANAGER_SCRIPT at top of file). Each friendsPage in the pool
  // already has __connectViewerStart / __connectViewerAwait / __disconnectViewer
  // / __disconnectAll / __activeCount available on window — no inline eval needed.

  async function getTurnstileToken(): Promise<string> {
    const token = await page.evaluate(`
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Turnstile timeout (30s)')), 30000);
        const container = document.getElementById('__ts_container');
        if (container) container.innerHTML = '';

        turnstile.render('#__ts_container', {
          sitekey: '${TURNSTILE_SITEKEY}',
          execution: 'execute',
          appearance: 'execute',
          callback: (token) => { clearTimeout(timeout); resolve(token); },
          'error-callback': (err) => { clearTimeout(timeout); reject(new Error('Turnstile error: ' + err)); },
        });

        setTimeout(() => { try { turnstile.execute('#__ts_container'); } catch(e) {} }, 500);
      })
    `);
    console.log('[BrowserAuth] Got Turnstile token (' + String(token).length + ' chars)');
    return token as string;
  }

  async function authenticateWallet(
    wallet: WalletInfo,
    allowRegistration: boolean,
  ): Promise<AuthTokens> {
    const MAX_ATTEMPTS = 3;
    let lastErr: any;
    const action = allowRegistration ? 'Signing up' : 'Logging in';
    const doneLabel = allowRegistration ? 'Signup' : 'Login';

    // A Cloudflare re-challenge (or SPA redirect) can navigate the main page
    // mid-login and destroy the JS execution context of the in-flight
    // Turnstile evaluate ("Execution context was destroyed, most likely
    // because of a navigation"). On that specific, navigation-caused error we
    // re-clear the page and retry — bounded — instead of failing the account.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`[BrowserAuth] ${action} wallet: ${wallet.publicKey} (attempt ${attempt}/${MAX_ATTEMPTS})`);

        // 0. Recover from any CF re-challenge / navigation that wiped the main
        //    page since the previous attempt, before the long Turnstile evaluate.
        await ensureMainPageReady();

        await runLoginApiHostVerification({
          hosts: apiHostsForLoginOrRefresh(sessionShards.apiHost),
          walletPublicKey: wallet.publicKey,
          allowRegistration,
          getNonce: async (host, walletPublicKey) => {
            console.log(`[BrowserAuth] Trying login API host ${host}`);
            const nonceRes = await apiPostFromPage(host, '/wallet-nonce', JSON.stringify({
              walletAddress: walletPublicKey,
              v: Date.now(),
            }));
            if (nonceRes.status < 200 || nonceRes.status >= 300) {
              const err: any = new Error(`Nonce failed on ${host}: ${nonceRes.status} - ${nonceRes.body}`);
              err.status = nonceRes.status;
              err.host = host;
              throw err;
            }
            console.log(`[BrowserAuth] Got nonce from ${host}:`, nonceRes.body);
            return nonceRes.body;
          },
          signNonce: (nonce) => {
            const message = buildSignMessage(nonce);
            const signature = nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey);
            return bs58.encode(signature);
          },
          getTurnstileToken,
          verify: async (host, payload) => {
            const verifyRes = await apiPostFromPage(host, '/verify-wallet-v2', JSON.stringify(payload));
            if (verifyRes.status < 200 || verifyRes.status >= 300) {
              const err: any = new Error(`Verify failed on ${host}: ${verifyRes.status} - ${verifyRes.body}`);
              err.status = verifyRes.status;
              err.host = host;
              throw err;
            }
            console.log(`[BrowserAuth] Verify response received from ${host}`);
          },
          onHostFailure: async (host, status, message) => {
            await context.clearCookies({ name: 'auth-access-token' }).catch(() => {});
            await context.clearCookies({ name: 'auth-refresh-token' }).catch(() => {});
            console.warn(`[BrowserAuth] Login API host ${host} failed (${status || 'network'}): ${message.split('\n')[0]}; trying next host...`);
          },
        });

        // Extract auth + CF cookies from browser.
        await page.waitForTimeout(500);
        const browserCookies = await context.cookies();
        let accessToken = '';
        let refreshToken = '';
        const parts: string[] = [];
        const seen = new Set<string>();

        for (const c of browserCookies) {
          // Auth cookies
          if (c.name === 'auth-access-token') { accessToken = c.value; }
          if (c.name === 'auth-refresh-token') { refreshToken = c.value; }

          // Include auth + CF cookies (needed for API and WS connections)
          if (c.name.startsWith('auth-') || c.name === 'cf_clearance' || c.name === '__cf_bm') {
            const key = `${c.name}=${c.value}`;
            if (!seen.has(c.name)) {
              seen.add(c.name);
              parts.push(key);
            }
          }
        }

        if (!accessToken) {
          throw new Error('No auth cookies received after verify');
        }

        console.log(`[BrowserAuth] ${doneLabel} successful! Access token:`, accessToken.slice(0, 20) + '...');
        console.log('[BrowserAuth] Cookie types:', [...seen].join(', '));

        // Clear auth cookies so next account starts fresh (keep CF cookies)
        await context.clearCookies({ name: 'auth-access-token' });
        await context.clearCookies({ name: 'auth-refresh-token' });

        return {
          accessToken,
          refreshToken,
          cookies: parts.join('; '),
        };
      } catch (err: any) {
        lastErr = err;
        const emsg = String(err?.message || err);
        // Playwright's symptom of a navigation landing mid-evaluate.
        const navRace = /Execution context was destroyed|frame (?:was |got )?detached|because of (?:a )?navigation/i.test(emsg);
        if (navRace && attempt < MAX_ATTEMPTS) {
          console.warn(`[BrowserAuth] ${doneLabel} attempt ${attempt}/${MAX_ATTEMPTS} hit a page navigation (${emsg.split('\n')[0]}); recovering & retrying...`);
          await page.waitForTimeout(1000);
          continue;
        }
        throw err;
      }
    }

    throw lastErr;
  }

  async function openManagedSession(
    accessToken: string,
    refreshToken: string,
    openOpts: BrowserSessionOpenOptions = {},
  ): Promise<number> {
    const slotIndex = Math.max(0, Math.floor(openOpts.slotIndex ?? 0));
    // Pick a page from the pool; default to slot 0 for callers that don't
    // care. viewer-service passes its worker index so each worker owns a
    // distinct page -> evaluates run truly in parallel.
    const sessionPage = friendsPages[slotIndex % friendsPages.length];

    // Discover clusterN only when actually opening viewer sessions (not on keep-warm open).
    const shards = await ensureSessionShards();

    // Set this account's auth cookies on every axiom subdomain we touch.
    // The WS handshake reads cookies from the matching domain, so the
    // auth-access-token must be present for the discovered cluster, friends,
    // AND .axiom.trade (the wildcard, used as fallback).
    const domains = buildAuthCookieDomains(shards.clusterWsUrl);
    const cookiesToAdd: { name: string; value: string; domain: string; path: string }[] = [];
    for (const domain of domains) {
      cookiesToAdd.push(
        { name: 'auth-access-token', value: accessToken, domain, path: '/' },
        { name: 'auth-refresh-token', value: refreshToken, domain, path: '/' },
      );
    }

    const scriptOpts = {
      pingJitterMs: typeof openOpts.pingJitterMs === 'number' ? openOpts.pingJitterMs : Math.floor(Math.random() * 1000),
      clusterUrl: shards.clusterWsUrl,
    };
    const sessionId = ++nextViewerId;

    // Cookie-locked critical section: addCookies -> synchronously construct
    // the WS pair (so cookies are captured) -> clear cookies. The handshake
    // runs outside the lock, in parallel across pool slots.
    const tStart = Date.now();
    await withCookieLock(async () => {
      try {
        await context.addCookies(cookiesToAdd);
        await sessionPage.evaluate(
          ({ id, opts }) => (globalThis as any).__openSession(id, opts),
          { id: sessionId, opts: scriptOpts },
        );
      } finally {
        await context.clearCookies({ name: 'auth-access-token' });
        await context.clearCookies({ name: 'auth-refresh-token' });
      }
    });
    const tStartDone = Date.now();

    // Wait for both WS handshakes to complete (no cookie lock held).
    await sessionPage.evaluate((id) => (globalThis as any).__openSessionAwait(id), sessionId);
    const tAwaitDone = Date.now();
    console.log(`[Timing] slot=${slotIndex} cookieLocked=${tStartDone - tStart}ms handshake=${tAwaitDone - tStartDone}ms`);

    viewerToPage.set(sessionId, sessionPage);
    console.log(`[BrowserAuth] Session ${sessionId} opened on slot ${slotIndex} (acct token=${accessToken.slice(0, 12)}..., pingJitter=${scriptOpts.pingJitterMs}ms)`);
    return sessionId;
  }

  async function navigateManagedSession(sessionId: number, actions: NavAction[]): Promise<void> {
    const sessionPage = viewerToPage.get(sessionId) ?? friendsPage;
    await sessionPage.evaluate(
      ({ id, navActions }) => (globalThis as any).__navigateSession(id, navActions),
      { id: sessionId, navActions: actions },
    );
  }

  async function closeManagedSession(sessionId: number): Promise<void> {
    const sessionPage = viewerToPage.get(sessionId) ?? friendsPage;
    await sessionPage.evaluate((id) => (globalThis as any).__closeSession(id), sessionId);
    viewerToPage.delete(sessionId);
  }

  return {
    async probeEucalyptus(pairAddress: string, accessToken?: string, refreshToken?: string): Promise<void> {
      return probeEucalyptusMessages(pairAddress, accessToken, refreshToken);
    },

    getSessionShards(): SessionShards {
      return { ...sessionShards };
    },

    async ensureSessionShards(): Promise<SessionShards> {
      return ensureSessionShards();
    },

    async loginAccount(wallet: WalletInfo): Promise<AuthTokens> {
      return authenticateWallet(wallet, false);
    },

    async signupAccount(wallet: WalletInfo): Promise<AuthTokens> {
      return authenticateWallet(wallet, true);
    },

    async refreshAccount(oldRefreshToken: string): Promise<AuthTokens> {
      // POST /refresh-access-token from the axiom.trade origin. The endpoint
      // reads auth-refresh-token from the cookie jar (we set it on the
      // context first) and responds with Set-Cookie for the new access token
      // (and usually a rotated refresh token). CORS allow-origin is
      // https://axiom.trade, so the fetch MUST run on friendsPage.
      const domains = buildAuthCookieDomains(sessionShards.clusterWsUrl);
      const cookiesToAdd: { name: string; value: string; domain: string; path: string }[] = [];
      for (const domain of domains) {
        cookiesToAdd.push({ name: 'auth-refresh-token', value: oldRefreshToken, domain, path: '/' });
      }
      await context.addCookies(cookiesToAdd);

      try {
        const tBefore = Date.now();
        const result = await friendsPage.evaluate(async (hosts) => {
          // Best-effort: most rate-limit headers are NOT CORS-safelisted, so a
          // cross-origin read (apiN from the axiom.trade page) usually returns
          // null for them. We still try — if the server exposes them we capture
          // the real numbers; otherwise the probe falls back to measuring the
          // ceiling/cooldown empirically.
          const RL_HEADERS = ['retry-after', 'ratelimit-remaining', 'ratelimit-limit',
            'ratelimit-reset', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'x-ratelimit-reset'];
          let lastResult = {
            url: '',
            ok: false,
            status: 0,
            body: 'no refresh hosts tried',
            elapsedMs: 0,
            headers: {} as Record<string, string>,
          };

          for (const host of hosts) {
            const url = 'https://' + host + '/refresh-access-token';
            const t0 = performance.now();
            try {
              const r = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              const text = await r.text();
              const headers: Record<string, string> = {};
              for (const k of RL_HEADERS) {
                const v = r.headers.get(k);
                if (v != null) headers[k] = v;
              }
              lastResult = { url, ok: r.ok, status: r.status, body: text.slice(0, 500), elapsedMs: Math.round(performance.now() - t0), headers };
              if (r.ok) return lastResult;
            } catch (e: any) {
              lastResult = {
                url,
                ok: false,
                status: 0,
                body: 'fetch error: ' + (e?.message || String(e)),
                elapsedMs: Math.round(performance.now() - t0),
                headers: {} as Record<string, string>,
              };
            }
          }
          return lastResult;
        }, apiHostsForSession());

        // What CDP saw for this exact request (real status / failure reason),
        // which beats the opaque status 0 the in-page fetch reports when the
        // response lacks CORS headers or the connection was reset.
        const cdp = lastRefreshNetwork && lastRefreshNetwork.ts >= tBefore ? lastRefreshNetwork : null;
        // Trust the in-page status when we got one; otherwise fall back to the
        // status CDP observed on the wire.
        const realStatus = result.status && result.status !== 0 ? result.status : (cdp?.status ?? 0);
        const cdpNote = cdp ? (cdp.failed ? ` net=${cdp.error}` : ` wire=${cdp.status} ${cdp.statusText}`) : '';

        // Surface rate-limit signals to callers. Passive: anything throttled or
        // carrying a rate-limit header gets logged. The probe reads err.status.
        const retryAfter = result.headers?.['retry-after'] ?? null;
        if (realStatus === 429 || retryAfter != null || (cdp?.failed)) {
          console.log(`[BrowserAuth] refresh signal: url=${result.url} js-status=${result.status} wire-status=${cdp?.status ?? '?'} failed=${cdp?.failed ?? false} reason=${cdp?.error ?? '-'} retry-after=${retryAfter ?? '?'} headers=${JSON.stringify(result.headers)}`);
        }

        if (!isRefreshResponseSuccessful(result.ok, realStatus)) {
          const err: any = new Error(`refresh-access-token ${realStatus}${retryAfter != null ? ` retry-after=${retryAfter}` : ''}:${cdpNote} ${result.body}`);
          err.status = realStatus;
          err.retryAfter = retryAfter != null ? Number(retryAfter) : null;
          err.elapsedMs = result.elapsedMs;
          err.cdpError = cdp?.error ?? null;
          throw err;
        }

        // Pull the rotated tokens out of the context cookie jar (set by Set-Cookie).
        await friendsPage.waitForTimeout(50); // tiny pause to let Set-Cookie commit
        const browserCookies = await context.cookies();
        let accessToken = '';
        let refreshToken = '';
        const parts: string[] = [];
        const seen = new Set<string>();
        for (const c of browserCookies) {
          if (c.name === 'auth-access-token') accessToken = c.value;
          if (c.name === 'auth-refresh-token') refreshToken = c.value;
          if (c.name.startsWith('auth-') || c.name === 'cf_clearance' || c.name === '__cf_bm') {
            if (!seen.has(c.name)) {
              seen.add(c.name);
              parts.push(`${c.name}=${c.value}`);
            }
          }
        }
        if (!accessToken) {
          const err: any = new Error(`refresh-access-token returned ${realStatus || 200} but no new auth-access-token cookie set`);
          err.status = realStatus || 200;
          err.code = 'NO_ACCESS_COOKIE';
          throw err;
        }
        console.log(`[BrowserAuth] Refresh OK, new access token ${accessToken.slice(0, 20)}... (refresh ${refreshToken ? 'rotated' : 'kept'})`);
        return {
          accessToken,
          refreshToken: refreshToken || oldRefreshToken,
          cookies: parts.join('; '),
        };
      } finally {
        await context.clearCookies({ name: 'auth-access-token' });
        await context.clearCookies({ name: 'auth-refresh-token' });
      }
    },

    async bootstrapSession(walletAddress: string, accessToken: string, refreshToken: string): Promise<void> {
      // Mirror the HTTP burst the real React client fires on first page load.
      // Empirically: viewer counts drop accounts that haven't called these
      // endpoints — even when otherwise logged in. Calling them appears to
      // "register" the session server-side so the cluster includes the user in
      // the e-{pair} broadcast.
      const domains = buildAuthCookieDomains(sessionShards.clusterWsUrl);
      const cookiesToAdd: { name: string; value: string; domain: string; path: string }[] = [];
      for (const domain of domains) {
        cookiesToAdd.push(
          { name: 'auth-access-token', value: accessToken, domain, path: '/' },
          { name: 'auth-refresh-token', value: refreshToken, domain, path: '/' },
        );
      }
      await context.addCookies(cookiesToAdd);

      try {
        const apiHost = sessionShards.apiHost || API_SHARD_PROBE_HOSTS[0];
        const results = await friendsPage.evaluate(async ({ wallet, host }: { wallet: string; host: string }) => {
          const v = Date.now();
          const base = 'https://' + host;
          const j = (url: string, init?: RequestInit) => fetch(url, { credentials: 'include', ...(init || {}) })
            .then(r => ({ url, status: r.status }))
            .catch((e: any) => ({ url, error: String(e?.message || e) }));
          const POST = (url: string, body: any) => j(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          // Order/grouping mirrors the bootstrap probe captured for a real client.
          return Promise.all([
            POST(base + '/bundle-key-and-wallets', { v }),
            POST(base + '/meme-open-positions-v3', { walletAddresses: [wallet], v }),
            POST(base + '/user-nonce-accounts', { userWallets: [wallet], v }),
            j(base + '/tracked-wallets-v4?v=' + v),
            j(base + '/watchlist-v2?v=' + v),
            j(base + '/get-settings?v=' + v),
            j(base + '/get-notifications?v=' + v),
            j(base + '/user-data?v=' + v),
            j(base + '/lighthouse?v=' + v),
            j(base + '/online-users-count?v=' + v),
          ]);
        }, { wallet: walletAddress, host: apiHost });

        const summary = (results as any[])
          .map(r => r.error ? `ERR(${r.url.split('/').pop()})` : `${r.url.split('/').pop()}=${r.status}`)
          .join(' ');
        console.log(`[BrowserAuth] bootstrap ${walletAddress.slice(0, 8)}... ${summary}`);
      } finally {
        await context.clearCookies({ name: 'auth-access-token' });
        await context.clearCookies({ name: 'auth-refresh-token' });
      }
    },

    async ensurePageSlots(n: number): Promise<void> {
      await ensurePageSlots(n);
    },

    async openSession(accessToken: string, refreshToken: string, opts: BrowserSessionOpenOptions = {}): Promise<number> {
      return openManagedSession(accessToken, refreshToken, opts);
    },

    async navigateSession(sessionId: number, actions: NavAction[]): Promise<void> {
      return navigateManagedSession(sessionId, actions);
    },

    async closeSession(sessionId: number): Promise<void> {
      return closeManagedSession(sessionId);
    },

    async fetchPairInfo(pairAddress: string): Promise<any | null> {
      const hosts = apiHostsForSession();
      for (const host of hosts) {
        try {
          const url = `https://${host}/pair-info?pairAddress=${pairAddress}&v=${Date.now()}`;
          const result = await friendsPage.evaluate(async (u) => {
            try {
              const r = await fetch(u, { credentials: 'include' });
              if (!r.ok) return { __err: 'status ' + r.status };
              return await r.json();
            } catch (e: any) {
              return { __err: 'fetch ' + (e?.message || String(e)) };
            }
          }, url);
          if (result && !(result as any).__err) {
            console.log(`[BrowserAuth] fetchPairInfo OK via ${host} pair=${pairAddress}`);
            return result;
          }
          console.log(`[BrowserAuth] fetchPairInfo ${host} -> ${(result as any)?.__err || 'empty response'}`);
        } catch (e: any) {
          console.log(`[BrowserAuth] fetchPairInfo evaluate error on ${host}:`, e.message);
        }
      }
      return null;
    },

    async fetchMemeTrending(): Promise<unknown> {
      const host = sessionShards.apiHost || API_SHARD_PROBE_HOSTS[0];
      const url = `https://${host}/meme-trending-v2?v=${Date.now()}`;
      return friendsPage.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) throw new Error('status ' + r.status);
        return r.json();
      }, url);
    },

    async connectViewer(accessToken: string, refreshToken: string, tokenInfo: any, pingJitterMs?: number, slotIndex: number = 0): Promise<number> {
      const tStart = Date.now();
      const sessionId = await openManagedSession(accessToken, refreshToken, { pingJitterMs, slotIndex });
      const actions = planEnterFromFeed(tokenInfo).map((action) => {
        if (action.op !== 'pageUpdate') return action;
        return { ...action, pageUpdate: pageUpdateMeme(tokenInfo) };
      });
      await navigateManagedSession(sessionId, actions);
      console.log(`[Timing] slot=${slotIndex} connectViewer compatibility path took ${Date.now() - tStart}ms`);
      console.log(`[BrowserAuth] Viewer ${sessionId} connected on slot ${slotIndex} (acct token=${accessToken.slice(0, 12)}...)`);
      return sessionId;
    },

    async resolvePairFromCa(ca: string, accessToken?: string, refreshToken?: string): Promise<any | null> {
      // Real client: GET /clipboard-pair-info?address={CA}. This endpoint is
      // AUTHENTICATED — without a valid auth-access-token cookie it returns a
      // 502 with {"error":"Session invalid, please login again"} (not a host
      // outage). So set a logged-in account's cookies for the call — a
      // cookie-locked critical section, like every other authed op — then
      // clear them. CORS allow-origin is axiom.trade only, so the fetch MUST
      // run on friendsPage.
      const domains = buildAuthCookieDomains(sessionShards.clusterWsUrl);
      if (accessToken) {
        const cookiesToAdd: { name: string; value: string; domain: string; path: string }[] = [];
        for (const domain of domains) {
          cookiesToAdd.push({ name: 'auth-access-token', value: accessToken, domain, path: '/' });
          if (refreshToken) cookiesToAdd.push({ name: 'auth-refresh-token', value: refreshToken, domain, path: '/' });
        }
        await context.addCookies(cookiesToAdd);
      }

      // A single apiN host can still 502 transiently; try discovered + fallbacks.
      const hosts = apiHostsForSession();
      try {
        for (const host of hosts) {
          try {
            const url = `https://${host}/clipboard-pair-info?address=${ca}&v=${Date.now()}`;
            const result = await friendsPage.evaluate(async (u) => {
              try {
                const r = await fetch(u, { credentials: 'include' });
                if (!r.ok) return { __err: 'status ' + r.status };
                return await r.json();
              } catch (e: any) {
                return { __err: 'fetch ' + (e?.message || String(e)) };
              }
            }, url);
            if (result && !(result as any).__err && (result as any).pairAddress) {
              console.log(`[BrowserAuth] resolvePairFromCa OK via ${host} pair=${(result as any).pairAddress}`);
              return result;
            }
            console.log(`[BrowserAuth] resolvePairFromCa ${host} -> ${(result as any)?.__err || 'no pairAddress'}`);
          } catch (e: any) {
            console.log(`[BrowserAuth] resolvePairFromCa evaluate error on ${host}:`, e.message);
          }
        }
        console.log('[BrowserAuth] resolvePairFromCa returned null for', ca);
        return null;
      } finally {
        if (accessToken) {
          await context.clearCookies({ name: 'auth-access-token' });
          await context.clearCookies({ name: 'auth-refresh-token' });
        }
      }
    },

    async disconnectViewer(viewerId: number): Promise<void> {
      await closeManagedSession(viewerId);
    },

    async disconnectAllViewers(): Promise<void> {
      await Promise.all(friendsPages.map(p => p.evaluate('window.__disconnectAll()')));
      viewerToPage.clear();
      console.log('[BrowserAuth] All viewers disconnected');
    },

    async getActiveViewerCount(): Promise<number> {
      const counts = await Promise.all(friendsPages.map(p => p.evaluate('window.__activeCount()') as Promise<number>));
      return counts.reduce((a, b) => a + b, 0);
    },

    async getCfData(): Promise<{ cfCookies: string; userAgent: string }> {
      // Get the exact user-agent from the browser
      const userAgent = await page.evaluate('navigator.userAgent') as string;

      // Get CF cookies from all axiom domains
      const allCookies = await context.cookies();
      const cfParts: string[] = [];
      const seen = new Set<string>();
      for (const c of allCookies) {
        if ((c.name === 'cf_clearance' || c.name === '__cf_bm') && !seen.has(c.name)) {
          seen.add(c.name);
          cfParts.push(`${c.name}=${c.value}`);
        }
      }

      console.log('[BrowserAuth] CF data: UA=' + userAgent.slice(0, 50) + '..., cookies=' + cfParts.length);
      return { cfCookies: cfParts.join('; '), userAgent };
    },

    async close(): Promise<void> {
      console.log('[BrowserAuth] Closing browser');
      try { await browser.close(); } catch {}
      try { chromeProc.kill(); } catch {}
      setTimeout(() => {
        try { fs.rmSync(tmpProfile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
      }, 2000);
    },
  };
}
