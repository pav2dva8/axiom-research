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
import type { AuthTokens, WalletInfo } from './auth';
import { buildSignMessage } from './auth';

const TURNSTILE_SITEKEY = '0x4AAAAAACb1mthF4yHVUfUh';
const API_BASE = 'https://api2.axiom.trade';
const DEBUG_PORT = 9222;

export interface BrowserSession {
  loginAccount(wallet: WalletInfo): Promise<AuthTokens>;
  getCfData(): Promise<{ cfCookies: string; userAgent: string }>;
  fetchPairInfo(pairAddress: string): Promise<any | null>;
  resolvePairFromCa(ca: string): Promise<any | null>;
  /**
   * Run the session bootstrap that the real client fires on every page load
   * (user-data, lighthouse, get-settings, ...). Without this the server
   * appears to skip new accounts when computing the e-{pair} viewer count
   * even though the account is otherwise logged in.
   */
  bootstrapSession(walletAddress: string, accessToken: string, refreshToken: string): Promise<void>;
  probeEucalyptus(pairAddress: string, accessToken?: string, refreshToken?: string): Promise<void>;
  connectViewer(accessToken: string, refreshToken: string, tokenInfo: any, pingJitterMs?: number): Promise<number>;
  disconnectViewer(viewerId: number): Promise<void>;
  disconnectAllViewers(): Promise<void>;
  getActiveViewerCount(): Promise<number>;
  close(): Promise<void>;
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

export async function openBrowserSession(): Promise<BrowserSession> {
  console.log('[BrowserAuth] Launching real Chrome...');

  // Kill any leftover Chrome on the debug port before spawning a new one
  try {
    const { execSync } = await import('child_process');
    execSync(`lsof -ti :${DEBUG_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 500));
  } catch {}

  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-chrome-'));
  const chromePath = findChrome();

  const chromeProc: ChildProcess = spawn(chromePath, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${tmpProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=800,600',
    '--window-position=100,100',
    'about:blank',
  ], {
    stdio: 'ignore',
    detached: false,
  });

  await new Promise(r => setTimeout(r, 2000));

  // Force IPv4 — Node 22's DNS prefers ::1 but Chrome's --remote-debugging-port
  // binds to 127.0.0.1 only. Retry a few times in case Chrome is still warming
  // up (cold launches on macOS can take a few seconds).
  const cdpUrl = `http://127.0.0.1:${DEBUG_PORT}`;
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

  console.log('[BrowserAuth] Connected to Chrome via CDP');

  const context: BrowserContext = browser.contexts()[0];
  const page: Page = context.pages()[0] || await context.newPage();

  // Navigate to axiom.trade
  await page.goto('https://axiom.trade', { waitUntil: 'load', timeout: 30000 });
  console.log('[BrowserAuth] Page loaded, URL:', page.url());

  // Handle CF challenge
  const content = await page.content();
  if (content.includes('challenges.cloudflare.com') || content.includes('challenge-platform') || content.includes('Verify you are human')) {
    console.log('[BrowserAuth] Cloudflare challenge detected — please complete it in the browser');
    await page.waitForURL(/axiom\.trade\/(?!.*challenge)/, { timeout: 120000 });
    await page.waitForLoadState('load');
    console.log('[BrowserAuth] Cloudflare challenge passed');
  } else {
    console.log('[BrowserAuth] No CF challenge — page loaded directly');
  }

  await page.waitForTimeout(3000);
  console.log('[BrowserAuth] Current URL:', page.url());

  // Load Turnstile API
  await page.evaluate(`(() => {
    const div = document.createElement('div');
    div.id = '__ts_container';
    div.style.position = 'fixed';
    div.style.bottom = '0';
    div.style.right = '0';
    div.style.zIndex = '99999';
    document.body.appendChild(div);

    if (typeof window.turnstile === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      document.head.appendChild(script);
    }
  })()`);

  await page.waitForFunction('typeof window.turnstile !== "undefined"', null, { timeout: 15000 })
    .catch(() => { throw new Error('Failed to load Turnstile API script'); });
  console.log('[BrowserAuth] Turnstile API loaded');

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

  // Open a single api2 tab for all API calls
  const apiPage = await context.newPage();
  await apiPage.goto(`${API_BASE}/`, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  await apiPage.waitForTimeout(1000);
  console.log('[BrowserAuth] API page ready');

  // Use axiom.trade as origin page for WS connections (friends server checks Origin header)
  const friendsPage = await context.newPage();
  await friendsPage.goto('https://axiom.trade', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  await friendsPage.waitForTimeout(1000);
  console.log('[BrowserAuth] Axiom page ready for WS connections');
  friendsPage.on('console', msg => {
    const t = msg.text();
    if (t.startsWith('[viewer ') || t.startsWith('[viewer]')) console.log('[Browser]', t);
  });

  // CDP-level WS frame sniffing + handshake/close diagnostics.
  // Tracking URL per-requestId lets us tag every log line with which server
  // it came from (cluster9 vs friends) and surface the handshake HTTP status
  // — which is what tells us "rejected by server" vs "TCP refused" vs "CF".
  const cdp = await context.newCDPSession(friendsPage);
  await cdp.send('Network.enable');
  const wsUrlByReq = new Map<string, string>();
  function tag(reqId: string): string {
    const u = wsUrlByReq.get(reqId) || reqId;
    return u.includes('cluster9') ? 'cluster9' : u.includes('friends') ? 'friends' : u;
  }
  cdp.on('Network.webSocketCreated', ({ requestId, url }: any) => {
    wsUrlByReq.set(requestId, url);
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
    console.log(`[CDP] ${tag(requestId)} frame error: ${errorMessage}`);
  });
  cdp.on('Network.webSocketClosed', ({ requestId }) => {
    console.log(`[CDP] ${tag(requestId)} closed`);
    wsUrlByReq.delete(requestId);
  });

  // Inject WS viewer manager into friends page.
  //
  // Protocol (reverse-engineered from a real client probe — see probe-logs/):
  //   - cluster9.axiom.trade is the room-pubsub server. Joining
  //     room "e-{pairAddress}" both registers the viewer AND subscribes
  //     to the live count broadcast. Eucalyptus is NOT used for this.
  //   - friends.axiom.trade gets one "pageUpdate" with the FULL token info
  //     as `subpage` (not a string). Keepalive is "." every 1s.
  //   - cluster9 keepalive is {"method":"ping"} every 30s.
  await friendsPage.evaluate(`(() => {
    window.__viewers = {};
    window.__nextId = 0;

    const CLUSTER_URL = 'wss://cluster9.axiom.trade/';
    const FRIENDS_URL = 'wss://friends.axiom.trade/ws';

    window.__connectViewer = (tokenInfo, opts) => {
      opts = opts || {};
      const pingJitterMs = typeof opts.pingJitterMs === 'number' ? opts.pingJitterMs : Math.floor(Math.random() * 1000);
      return new Promise((resolve, reject) => {
        const id = ++window.__nextId;
        const pairAddress = tokenInfo.pairAddress;

        const clusterWs = new WebSocket(CLUSTER_URL);
        const friendsWs = new WebSocket(FRIENDS_URL);
        const timeout = setTimeout(() => fail('WS timeout'), 12000);

        // Rooms the real client joins on the meme page. Joining the full set
        // makes us look like a normal viewer; "e-" is the one that bumps the
        // count. Order matches the real client.
        const tokenRooms = [
          't:'  + pairAddress,
          'f:'  + pairAddress,
          'td:' + pairAddress,
          's:'  + pairAddress,
          'b-'  + pairAddress,
          'e-'  + pairAddress,
        ];

        let clusterOpen = false, friendsOpen = false;
        let settled = false;
        let friendsPingTimer = 0, clusterPingTimer = 0, friendsPingStart = 0;
        const tStart = Date.now();
        function killBoth() {
          try { clusterWs.close(); } catch (_) {}
          try { friendsWs.close(); } catch (_) {}
        }
        function fail(why) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          killBoth();
          reject(new Error(why));
        }
        function tryResolve() {
          if (!clusterOpen || !friendsOpen || settled) return;
          settled = true;
          clearTimeout(timeout);

          // friends keepalive: "." every 1s, but offset start by jitter so
          // multiple viewer pings don't all fire on the same wall-clock tick.
          friendsPingStart = setTimeout(() => {
            friendsPingTimer = setInterval(() => {
              if (friendsWs.readyState === 1) friendsWs.send('.');
              else clearInterval(friendsPingTimer);
            }, 1000);
          }, pingJitterMs);

          // cluster9 keepalive: {"method":"ping"} every 30s, also offset.
          clusterPingTimer = setInterval(() => {
            if (clusterWs.readyState === 1) clusterWs.send(JSON.stringify({ method: 'ping' }));
            else clearInterval(clusterPingTimer);
          }, 30000 + Math.floor(Math.random() * 5000));

          window.__viewers[id] = {
            clusterWs, friendsWs,
            friendsPingTimer, clusterPingTimer, friendsPingStart,
            pairAddress,
          };
          resolve(id);
        }

        clusterWs.onopen = () => {
          for (const room of tokenRooms) {
            clusterWs.send(JSON.stringify({ action: 'join', room }));
          }
          console.log('[viewer ' + id + '] cluster9 joined ' + tokenRooms.length + ' rooms (e-' + pairAddress.slice(0, 6) + '...)');
          clusterOpen = true;
          tryResolve();
        };
        clusterWs.onmessage = (e) => {
          // Surface viewer-count broadcasts so we can confirm we're being counted
          try {
            const msg = JSON.parse(e.data);
            if (msg.room === 'e-' + pairAddress) {
              console.log('[viewer ' + id + '] eye-room count = ' + msg.content);
            }
          } catch {}
        };
        clusterWs.onerror = () => {
          // onerror has no useful detail in browsers; rely on onclose for reason.
          console.log('[viewer ' + id + '] cluster9 error event');
        };
        clusterWs.onclose = (e) => {
          const dt = Date.now() - tStart;
          console.log('[viewer ' + id + '] cluster9 closed code=' + e.code + ' clean=' + e.wasClean + ' reason="' + (e.reason || '') + '" after ' + dt + 'ms');
          const v = window.__viewers[id];
          if (v) {
            clearTimeout(v.friendsPingStart);
            clearInterval(v.friendsPingTimer);
            clearInterval(v.clusterPingTimer);
            delete window.__viewers[id];
          }
          if (!settled) fail('cluster9 closed code=' + e.code + (e.reason ? ' reason=' + e.reason : ''));
        };

        friendsWs.onopen = () => {
          // Real client sends pageUpdate with the FULL token info as subpage.
          friendsWs.send(JSON.stringify({
            type: 'pageUpdate',
            page: 'meme',
            subpage: tokenInfo,
            chain: 'sol',
          }));
          friendsOpen = true;
          tryResolve();
        };
        friendsWs.onmessage = (e) => {
          if (e.data === '.') return; // friends "." pong
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'ping') friendsWs.send(JSON.stringify({ type: 'pong' }));
          } catch {}
        };
        friendsWs.onerror = () => {
          console.log('[viewer ' + id + '] friends error event');
        };
        friendsWs.onclose = (e) => {
          const dt = Date.now() - tStart;
          console.log('[viewer ' + id + '] friends closed code=' + e.code + ' clean=' + e.wasClean + ' reason="' + (e.reason || '') + '" after ' + dt + 'ms');
          if (!settled) fail('friends closed code=' + e.code + (e.reason ? ' reason=' + e.reason : ''));
        };
      });
    };

    window.__disconnectViewer = (id) => {
      const v = window.__viewers[id];
      if (!v) return;
      clearTimeout(v.friendsPingStart);
      clearInterval(v.friendsPingTimer);
      clearInterval(v.clusterPingTimer);
      try { v.clusterWs.close(); } catch {}
      try { v.friendsWs.close(); } catch {}
      delete window.__viewers[id];
    };

    window.__disconnectAll = () => {
      for (const id of Object.keys(window.__viewers)) {
        const v = window.__viewers[id];
        clearTimeout(v.friendsPingStart);
        clearInterval(v.friendsPingTimer);
        clearInterval(v.clusterPingTimer);
        try { v.clusterWs.close(); } catch {}
        try { v.friendsWs.close(); } catch {}
      }
      window.__viewers = {};
    };

    window.__activeCount = () => {
      return Object.values(window.__viewers).filter(v => v.clusterWs.readyState === 1).length;
    };
  })()`);

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

  return {
    async probeEucalyptus(pairAddress: string, accessToken?: string, refreshToken?: string): Promise<void> {
      return probeEucalyptusMessages(pairAddress, accessToken, refreshToken);
    },

    async fetchPairInfo(pairAddress: string): Promise<any | null> {
      // Run from the axiom.trade origin (friendsPage) — api9/api2 only set
      // CORS allow-origin to https://axiom.trade, so calling from api2.axiom.trade
      // (where apiPage lives) fails CORS and returns null silently.
      const hosts = ['api9.axiom.trade', 'api2.axiom.trade'];
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
            console.log(`[BrowserAuth] fetchPairInfo OK via ${host}, tokenAddress=${(result as any).tokenAddress || 'n/a'}`);
            return result;
          }
          console.log(`[BrowserAuth] fetchPairInfo ${host} -> ${(result as any)?.__err || 'no body'}`);
        } catch (e: any) {
          console.log(`[BrowserAuth] fetchPairInfo evaluate error on ${host}:`, e.message);
        }
      }
      console.log('[BrowserAuth] fetchPairInfo returned null for', pairAddress);
      return null;
    },

    async loginAccount(wallet: WalletInfo): Promise<AuthTokens> {
      console.log('[BrowserAuth] Logging in wallet:', wallet.publicKey);

      // 1. Get turnstile token
      const turnstileToken = await getTurnstileToken();

      // 2. Get nonce via same-origin fetch from api2 page
      const nonce = await apiPage.evaluate(`
        fetch('/wallet-nonce', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: '${wallet.publicKey}' }),
        }).then(async r => {
          if (!r.ok) {
            const text = await r.text();
            throw new Error('Nonce failed: ' + r.status + ' ' + r.statusText + ' - ' + text);
          }
          return r.text();
        })
      `) as string;
      console.log('[BrowserAuth] Got nonce:', nonce);

      // 3. Sign message in Node.js
      const message = buildSignMessage(nonce);
      const messageBytes = new TextEncoder().encode(message);
      const signature = nacl.sign.detached(messageBytes, wallet.secretKey);
      const signatureBase58 = bs58.encode(signature);

      // 4. Verify wallet via same-origin fetch from api2 page
      // Return the response body + set-cookie info
      const result = await apiPage.evaluate(`
        fetch('/verify-wallet-v2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress: '${wallet.publicKey}',
            allowLinking: false,
            allowRegistration: false,
            forAddCredential: false,
            isVerify: false,
            nonce: '${nonce}',
            referrer: null,
            signature: '${signatureBase58}',
            turnstileToken: '${turnstileToken}',
          }),
        }).then(async r => {
          const text = await r.text();
          if (!r.ok) throw new Error('Verify failed: ' + r.status + ' ' + r.statusText + ' - ' + text);
          return text;
        })
      `) as string;
      console.log('[BrowserAuth] Verify response received');

      // 5. Extract auth + CF cookies from browser
      await apiPage.waitForTimeout(500);
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

      console.log('[BrowserAuth] Login successful! Access token:', accessToken.slice(0, 20) + '...');
      console.log('[BrowserAuth] Cookie types:', [...seen].join(', '));

      // Clear auth cookies so next account starts fresh (keep CF cookies)
      await context.clearCookies({ name: 'auth-access-token' });
      await context.clearCookies({ name: 'auth-refresh-token' });

      return {
        accessToken,
        refreshToken,
        cookies: parts.join('; '),
      };
    },

    async bootstrapSession(walletAddress: string, accessToken: string, refreshToken: string): Promise<void> {
      // Mirror the HTTP burst the real React client fires on first page load.
      // Empirically: viewer counts drop accounts that haven't called these
      // endpoints — even when otherwise logged in. Calling them appears to
      // "register" the session server-side so cluster9 includes the user in
      // the e-{pair} broadcast.
      const domains = ['cluster9.axiom.trade', 'friends.axiom.trade', '.axiom.trade'];
      const cookiesToAdd: { name: string; value: string; domain: string; path: string }[] = [];
      for (const domain of domains) {
        cookiesToAdd.push(
          { name: 'auth-access-token', value: accessToken, domain, path: '/' },
          { name: 'auth-refresh-token', value: refreshToken, domain, path: '/' },
        );
      }
      await context.addCookies(cookiesToAdd);

      try {
        const results = await friendsPage.evaluate(async (wallet: string) => {
          const v = Date.now();
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
            POST('https://api9.axiom.trade/bundle-key-and-wallets', { v }),
            POST('https://api9.axiom.trade/meme-open-positions-v3', { walletAddresses: [wallet], v }),
            POST('https://api9.axiom.trade/user-nonce-accounts', { userWallets: [wallet], v }),
            j('https://api9.axiom.trade/tracked-wallets-v3?v=' + v),
            j('https://api9.axiom.trade/watchlist-v2?v=' + v),
            j('https://api9.axiom.trade/get-settings?v=' + v),
            j('https://api9.axiom.trade/get-notifications?v=' + v),
            j('https://api9.axiom.trade/user-data?v=' + v),
            j('https://api9.axiom.trade/lighthouse?v=' + v),
            j('https://api9.axiom.trade/online-users-count?v=' + v),
          ]);
        }, walletAddress);

        const summary = (results as any[])
          .map(r => r.error ? `ERR(${r.url.split('/').pop()})` : `${r.url.split('/').pop()}=${r.status}`)
          .join(' ');
        console.log(`[BrowserAuth] bootstrap ${walletAddress.slice(0, 8)}... ${summary}`);
      } finally {
        await context.clearCookies({ name: 'auth-access-token' });
        await context.clearCookies({ name: 'auth-refresh-token' });
      }
    },

    async connectViewer(accessToken: string, refreshToken: string, tokenInfo: any, pingJitterMs?: number): Promise<number> {
      // Set this account's auth cookies on every axiom subdomain we touch.
      // The WS handshake reads cookies from the matching domain, so the
      // auth-access-token must be present for cluster9, friends, AND
      // .axiom.trade (the wildcard, used as fallback).
      const domains = [
        'cluster9.axiom.trade',
        'friends.axiom.trade',
        '.axiom.trade',
      ];
      const cookiesToAdd = [];
      for (const domain of domains) {
        cookiesToAdd.push(
          { name: 'auth-access-token', value: accessToken, domain, path: '/' },
          { name: 'auth-refresh-token', value: refreshToken, domain, path: '/' },
        );
      }
      await context.addCookies(cookiesToAdd);

      // Create WS connection from the browser (uses current cookies for handshake)
      const opts = { pingJitterMs: typeof pingJitterMs === 'number' ? pingJitterMs : Math.floor(Math.random() * 1000) };
      const viewerId = await friendsPage.evaluate(
        `window.__connectViewer(${JSON.stringify(tokenInfo)}, ${JSON.stringify(opts)})`
      ) as number;

      // Clear auth cookies so the next account's handshake doesn't reuse them.
      // Existing WS connections keep the identity captured at handshake time.
      await context.clearCookies({ name: 'auth-access-token' });
      await context.clearCookies({ name: 'auth-refresh-token' });

      console.log(`[BrowserAuth] Viewer ${viewerId} connected (acct token=${accessToken.slice(0, 12)}..., pingJitter=${opts.pingJitterMs}ms)`);
      return viewerId;
    },

    async resolvePairFromCa(ca: string): Promise<any | null> {
      // Real client: GET /clipboard-pair-info?address={CA}.
      // CORS allow-origin is https://axiom.trade only, so we MUST issue this
      // from friendsPage (which is on axiom.trade), not from apiPage (api2).
      const hosts = ['api9.axiom.trade', 'api2.axiom.trade'];
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
    },

    async disconnectViewer(viewerId: number): Promise<void> {
      await friendsPage.evaluate(`window.__disconnectViewer(${viewerId})`);
    },

    async disconnectAllViewers(): Promise<void> {
      await friendsPage.evaluate('window.__disconnectAll()');
      console.log('[BrowserAuth] All viewers disconnected');
    },

    async getActiveViewerCount(): Promise<number> {
      return await friendsPage.evaluate('window.__activeCount()') as number;
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
