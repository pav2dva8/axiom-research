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
  connectViewer(accessToken: string, refreshToken: string, tokenInfo: any): Promise<number>;
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

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
  } catch (err: any) {
    chromeProc.kill();
    throw new Error(`Failed to connect to Chrome: ${err.message}`);
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

  // Open a single api2 tab for all API calls
  const apiPage = await context.newPage();
  await apiPage.goto(`${API_BASE}/`, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  await apiPage.waitForTimeout(1000);
  console.log('[BrowserAuth] API page ready');

  // Visit friends.axiom.trade — keep page open for WS connections
  const friendsPage = await context.newPage();
  await friendsPage.goto('https://friends.axiom.trade/', { waitUntil: 'load', timeout: 15000 }).catch(() => {});
  await friendsPage.waitForTimeout(1000);
  console.log('[BrowserAuth] Friends page ready for WS connections');

  // Inject WS viewer manager into friends page
  await friendsPage.evaluate(`(() => {
    window.__viewers = {};
    window.__nextId = 0;

    window.__connectViewer = (tokenInfo) => {
      return new Promise((resolve, reject) => {
        const id = ++window.__nextId;
        const ws = new WebSocket('wss://friends.axiom.trade/ws');
        const timeout = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 10000);

        ws.onopen = () => {
          clearTimeout(timeout);
          ws.send(JSON.stringify({ type: 'pageUpdate', page: 'meme', subpage: tokenInfo, chain: 'sol' }));
          const ping = setInterval(() => {
            if (ws.readyState === 1) ws.send('.');
            else clearInterval(ping);
          }, 1000);
          window.__viewers[id] = { ws, ping };
          resolve(id);
        };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('WS error')); };
        ws.onclose = () => {
          clearTimeout(timeout);
          if (window.__viewers[id]) {
            clearInterval(window.__viewers[id].ping);
            delete window.__viewers[id];
          }
        };
      });
    };

    window.__disconnectViewer = (id) => {
      const v = window.__viewers[id];
      if (v) { clearInterval(v.ping); v.ws.close(); delete window.__viewers[id]; }
    };

    window.__disconnectAll = () => {
      for (const [id, v] of Object.entries(window.__viewers)) {
        clearInterval(v.ping); v.ws.close();
      }
      window.__viewers = {};
    };

    window.__activeCount = () => {
      return Object.values(window.__viewers).filter(v => v.ws.readyState === 1).length;
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

    async connectViewer(accessToken: string, refreshToken: string, tokenInfo: any): Promise<number> {
      // Set this account's auth cookies in the browser
      const domains = ['friends.axiom.trade', '.axiom.trade'];
      const cookiesToAdd = [];
      for (const domain of domains) {
        cookiesToAdd.push(
          { name: 'auth-access-token', value: accessToken, domain, path: '/' },
          { name: 'auth-refresh-token', value: refreshToken, domain, path: '/' },
        );
      }
      await context.addCookies(cookiesToAdd);

      // Create WS connection from the browser (uses current cookies for handshake)
      const viewerId = await friendsPage.evaluate(
        `window.__connectViewer(${JSON.stringify(tokenInfo)})`
      ) as number;

      // Clear auth cookies for next account (existing WS connections keep their handshake identity)
      await context.clearCookies({ name: 'auth-access-token' });
      await context.clearCookies({ name: 'auth-refresh-token' });

      console.log(`[BrowserAuth] Viewer ${viewerId} connected`);
      return viewerId;
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
