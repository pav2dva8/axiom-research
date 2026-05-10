/**
 * Token-page traffic probe.
 *
 * Launches a real Chrome with remote debugging, lets you log into axiom.trade
 * MANUALLY in the same browser (handles CF + sign-in), then captures every
 * WebSocket frame and every HTTP request related to the target token page.
 *
 * Output: a timestamped log file under ./probe-logs/ that we can diff
 * against what our bot sends.
 *
 * Usage:
 *   tsx src/probe-token-page.ts <pairAddress> [durationSec]
 *
 * Example:
 *   tsx src/probe-token-page.ts Amk61ySm6z9hWSRSEsCKiMMb3i1G8ph89wNP9FzhBzsN 120
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, CDPSession } from 'playwright';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DEBUG_PORT = 9223; // different from browser-auth's 9222 to avoid collisions
const PAIR = process.argv[2];
const DURATION_SEC = parseInt(process.argv[3] || '120', 10);

if (!PAIR) {
  console.error('Usage: tsx src/probe-token-page.ts <pairAddress> [durationSec]');
  process.exit(1);
}

function findChrome(): string {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found.');
}

interface LogLine { t: number; kind: string; data: any; }
const logBuffer: LogLine[] = [];
const startedAt = Date.now();

function log(kind: string, data: any) {
  const t = Date.now() - startedAt;
  logBuffer.push({ t, kind, data });
  // condensed live print
  let preview = '';
  if (typeof data === 'string') preview = data.slice(0, 220);
  else if (data && typeof data === 'object') {
    try { preview = JSON.stringify(data).slice(0, 220); } catch { preview = String(data).slice(0, 220); }
  } else preview = String(data);
  console.log(`+${(t / 1000).toFixed(1)}s [${kind}] ${preview}`);
}

async function main() {
  const logDir = path.join(process.cwd(), 'probe-logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logDir, `probe-${PAIR.slice(0, 8)}-${stamp}.jsonl`);
  console.log(`\n[Probe] target pair = ${PAIR}`);
  console.log(`[Probe] duration   = ${DURATION_SEC}s`);
  console.log(`[Probe] log file   = ${logFile}\n`);

  // Kill anything on the debug port
  try {
    const { execSync } = await import('child_process');
    execSync(`lsof -ti :${DEBUG_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 300));
  } catch {}

  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-probe-'));
  const chromePath = findChrome();
  const chromeProc: ChildProcess = spawn(chromePath, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${tmpProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    '--window-position=80,80',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  await new Promise(r => setTimeout(r, 1500));

  // Force IPv4 — Node 22's DNS prefers ::1 but Chrome's --remote-debugging-port
  // binds to 127.0.0.1 only. Retry a few times in case Chrome is still warming
  // up (cold launches on macOS can take a few seconds).
  const cdpUrl = `http://127.0.0.1:${DEBUG_PORT}`;
  let browser: Browser | null = null;
  let lastErr: any;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      break;
    } catch (err: any) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  if (!browser) {
    chromeProc.kill();
    throw new Error(`Failed to connect to Chrome at ${cdpUrl}: ${lastErr?.message}`);
  }

  const context: BrowserContext = browser.contexts()[0];
  const page: Page = context.pages()[0] || await context.newPage();

  console.log('[Probe] Chrome launched. Open https://axiom.trade in this window,');
  console.log('[Probe] complete the Cloudflare check, sign in with your wallet,');
  console.log(`[Probe] and navigate to https://axiom.trade/meme/${PAIR}?chain=sol`);
  console.log('[Probe] Recording starts NOW — every WS frame and HTTP request is being captured.\n');

  // Pre-navigate to axiom.trade so the user lands there
  page.goto('https://axiom.trade', { waitUntil: 'load', timeout: 60000 }).catch(() => {});

  // Track every page in the context, including new tabs
  const cdpByTarget = new Map<string, CDPSession>();

  async function attachToPage(p: Page) {
    let cdp: CDPSession;
    try { cdp = await context.newCDPSession(p); }
    catch (e: any) { log('attach-error', { url: p.url(), error: e.message }); return; }

    cdpByTarget.set(p.url(), cdp);

    await cdp.send('Network.enable').catch(() => {});
    await cdp.send('Page.enable').catch(() => {});

    // Endpoints whose response BODY we want to capture (per-user state lives
    // here — anything that can mark an account as a "real trader" for viewer
    // eligibility will show up in one of these payloads).
    const captureBodyRegex = /\/(user-data|lighthouse|get-settings|get-notifications|sharing-config-v2|online-users-count|tracked-wallets-v3|watchlist-v2|verify-wallet-v2|refresh-access-token|user-nonce-accounts|bundle-key-and-wallets|meme-open-positions-v3|top-traders-v5)/;

    // Stash url+request-id while the response is in flight; pull body after
    // loadingFinished so the body is fully buffered.
    const requestUrls = new Map<string, { url: string; method: string }>();

    cdp.on('Network.requestWillBeSent', (params: any) => {
      const u = params.request.url || '';
      if (!/axiom\.trade/.test(u)) return;
      requestUrls.set(params.requestId, { url: u, method: params.request.method });
      log('http-request', {
        method: params.request.method,
        url: u,
        headers: params.request.headers,
        postData: params.request.postData,
        type: params.type,
      });
    });
    cdp.on('Network.responseReceived', (params: any) => {
      const u = params.response.url || '';
      if (!/axiom\.trade/.test(u)) return;
      log('http-response', {
        requestId: params.requestId,
        url: u,
        status: params.response.status,
        statusText: params.response.statusText,
        headers: params.response.headers,
        type: params.type,
      });
    });
    cdp.on('Network.loadingFinished', async (params: any) => {
      const meta = requestUrls.get(params.requestId);
      if (!meta) return;
      requestUrls.delete(params.requestId);
      if (!captureBodyRegex.test(meta.url)) return;
      try {
        const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId: params.requestId }) as any;
        const decoded = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
        log('http-body', {
          requestId: params.requestId,
          url: meta.url,
          method: meta.method,
          body: decoded.slice(0, 8000), // cap to keep log file sane
        });
      } catch (e: any) {
        log('http-body-error', { url: meta.url, error: e.message });
      }
    });

    cdp.on('Network.webSocketCreated', (params: any) => {
      log('ws-created', { url: params.url, requestId: params.requestId });
    });
    cdp.on('Network.webSocketWillSendHandshakeRequest', (params: any) => {
      log('ws-handshake-req', {
        requestId: params.requestId,
        headers: params.request?.headers,
      });
    });
    cdp.on('Network.webSocketHandshakeResponseReceived', (params: any) => {
      log('ws-handshake-resp', {
        requestId: params.requestId,
        status: params.response?.status,
        statusText: params.response?.statusText,
        headers: params.response?.headers,
      });
    });
    cdp.on('Network.webSocketFrameSent', (params: any) => {
      const payload = params.response?.payloadData ?? '';
      log('ws-sent', { requestId: params.requestId, payload });
    });
    cdp.on('Network.webSocketFrameReceived', (params: any) => {
      const payload = params.response?.payloadData ?? '';
      log('ws-recv', { requestId: params.requestId, payload });
    });
    cdp.on('Network.webSocketFrameError', (params: any) => {
      log('ws-error', { requestId: params.requestId, error: params.errorMessage });
    });
    cdp.on('Network.webSocketClosed', (params: any) => {
      log('ws-closed', { requestId: params.requestId });
    });

    p.on('framenavigated', f => {
      if (f === p.mainFrame()) log('navigated', { url: f.url() });
    });
  }

  // Attach to existing pages
  for (const p of context.pages()) await attachToPage(p);
  // Attach to new pages too (e.g. user opens a new tab)
  context.on('page', async (p: Page) => {
    log('new-page', { url: p.url() });
    p.once('load', () => attachToPage(p).catch(() => {}));
    // also attach immediately to catch early frames
    attachToPage(p).catch(() => {});
  });

  // Periodic flush of the log buffer to disk so we don't lose data on crash
  const flushTimer = setInterval(() => {
    if (logBuffer.length === 0) return;
    const lines = logBuffer.splice(0).map(l => JSON.stringify(l)).join('\n') + '\n';
    fs.appendFileSync(logFile, lines);
  }, 1000);

  // Wait
  console.log(`[Probe] Recording for ${DURATION_SEC}s...`);
  await new Promise(r => setTimeout(r, DURATION_SEC * 1000));

  clearInterval(flushTimer);
  // Final flush
  if (logBuffer.length > 0) {
    const lines = logBuffer.splice(0).map(l => JSON.stringify(l)).join('\n') + '\n';
    fs.appendFileSync(logFile, lines);
  }

  console.log('\n[Probe] Done. Closing browser...');
  try { await browser.close(); } catch {}
  try { chromeProc.kill(); } catch {}
  setTimeout(() => {
    try { fs.rmSync(tmpProfile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }, 1500);

  console.log(`[Probe] Log saved to ${logFile}`);
  console.log(`[Probe] Quick summary:`);
  const summary = summarize(logFile);
  console.log(summary);
}

function summarize(file: string): string {
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  const counts: Record<string, number> = {};
  const wsUrls: Set<string> = new Set();
  const httpUrls: Map<string, number> = new Map();
  for (const l of lines) {
    let evt: LogLine;
    try { evt = JSON.parse(l); } catch { continue; }
    counts[evt.kind] = (counts[evt.kind] || 0) + 1;
    if (evt.kind === 'ws-created' && evt.data?.url) wsUrls.add(evt.data.url);
    if (evt.kind === 'http-request' && evt.data?.url) {
      const u = evt.data.url.split('?')[0];
      httpUrls.set(u, (httpUrls.get(u) || 0) + 1);
    }
  }
  const parts: string[] = [];
  parts.push('  events: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', '));
  parts.push('  ws urls:');
  for (const u of wsUrls) parts.push('    - ' + u);
  parts.push('  http urls (top 15):');
  const sortedHttp = [...httpUrls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [u, c] of sortedHttp) parts.push(`    [${c}] ${u}`);
  return parts.join('\n');
}

main().catch(err => {
  console.error('[Probe] FATAL:', err);
  process.exit(1);
});
