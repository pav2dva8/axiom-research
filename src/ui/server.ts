/**
 * Viewer Bot Web Server
 *
 * Simple HTTP server with WebSocket for real-time updates
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { PublicKey, Connection } from '@solana/web3.js';
import { AccountManager } from './account-manager';
import { ViewerService } from './viewer-service';
import { ProxyManager } from './proxy-manager';

const PORT = process.env.PORT || 3847;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const accountManager = new AccountManager();
const viewerService = new ViewerService();
const proxyManager = new ProxyManager();
const solanaConnection = new Connection(SOLANA_RPC);

// Monitor state
let monitorInterval: NodeJS.Timeout | null = null;
let monitorCA: string | null = null;

// Derive pump.fun bonding curve (pair address) from CA
function derivePairAddress(ca: string): string {
  const mint = new PublicKey(ca);
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM
  );
  return bondingCurve.toBase58();
}

// Check if token exists on chain
async function checkTokenExists(ca: string): Promise<boolean> {
  try {
    const mint = new PublicKey(ca);
    const info = await solanaConnection.getAccountInfo(mint);
    return info !== null;
  } catch {
    return false;
  }
}

// Track connected UI clients
const uiClients: Set<WebSocket> = new Set();

// Stop flag for account creation
let stopAccountCreation = false;

// Broadcast to all UI clients
function broadcast(type: string, data: any): void {
  const message = JSON.stringify({ type, data });
  for (const client of uiClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Send current status to all clients
function broadcastStatus(): void {
  broadcast('status', {
    accounts: accountManager.getAccountCount(),
    activeViewers: viewerService.getActiveCount(),
    pendingViewers: viewerService.getPendingCount(),
    gradualRunning: viewerService.isGradualRunning(),
    proxies: proxyManager.getStats(),
    unusedProxies: proxyManager.getUnusedCount(),
  });
}

// Set up viewer service events
viewerService.on('viewer-connected', () => broadcastStatus());
viewerService.on('viewer-disconnected', () => broadcastStatus());
viewerService.on('gradual-tick', () => broadcastStatus());
viewerService.on('gradual-complete', () => {
  broadcast('gradual-complete', {});
  broadcastStatus();
});

// Handle API requests
async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    // GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        accounts: accountManager.getAccountCount(),
        activeViewers: viewerService.getActiveCount(),
        pendingViewers: viewerService.getPendingCount(),
        gradualRunning: viewerService.isGradualRunning(),
      }));
      return;
    }

    // GET /api/accounts
    if (pathname === '/api/accounts' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify(accountManager.listAccounts()));
      return;
    }

    // POST /api/accounts/create
    if (pathname === '/api/accounts/create' && req.method === 'POST') {
      const body = await readBody(req);
      const { count } = JSON.parse(body);

      res.writeHead(200);
      stopAccountCreation = false;

      let created = 0;
      let failed = 0;

      for (let i = 0; i < count; i++) {
        // Check if stopped by user
        if (stopAccountCreation) {
          broadcast('account-error', { error: 'Stopped by user' });
          break;
        }

        // Check if we have any proxies left
        const unusedProxies = proxyManager.getUnusedCount();
        if (unusedProxies === 0 && proxyManager.getStats().good > 0) {
          broadcast('account-error', { error: 'Stopped: No more unused proxies available' });
          break;
        }

        try {
          const account = await accountManager.createAccount(proxyManager);
          if (account) {
            created++;
            broadcast('account-created', { created, total: count, proxiesLeft: proxyManager.getUnusedCount() });
          } else {
            failed++;
            broadcast('account-error', { error: 'Creation failed (no proxy or error)' });
          }
        } catch (err: any) {
          failed++;
          broadcast('account-error', { error: err.message, proxiesLeft: proxyManager.getUnusedCount() });
        }
        broadcastStatus();
        await new Promise(r => setTimeout(r, 200));
      }

      broadcastStatus();
      res.end(JSON.stringify({ created, failed }));
      return;
    }

    // POST /api/accounts/stop
    if (pathname === '/api/accounts/stop' && req.method === 'POST') {
      stopAccountCreation = true;
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // DELETE /api/accounts
    if (pathname === '/api/accounts' && req.method === 'DELETE') {
      accountManager.deleteAllAccounts();
      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // POST /api/accounts/relogin
    if (pathname === '/api/accounts/relogin' && req.method === 'POST') {
      res.writeHead(200);

      const total = accountManager.getAccountCount();
      let done = 0;

      const success = await accountManager.reloginAllAccounts((completed, totalCount) => {
        done = completed;
        broadcast('relogin-progress', { done, total: totalCount });
      });

      broadcastStatus();
      res.end(JSON.stringify({ success, total }));
      return;
    }

    // POST /api/viewers/start
    if (pathname === '/api/viewers/start' && req.method === 'POST') {
      const body = await readBody(req);
      const {
        pairAddress,
        immediateEnabled,
        immediateCount,
        gradualEnabled,
        gradualCount,
        gradualInterval
      } = JSON.parse(body);

      // Fetch token info
      let tokenInfo = await viewerService.fetchTokenInfo(pairAddress);
      if (!tokenInfo) {
        tokenInfo = {
          pairAddress,
          tokenAddress: '',
          ticker: 'TOKEN',
          name: 'Token',
          protocol: 'Pump V1',
          isMigrated: false,
          supply: 1000000000,
          price: 0
        };
      }
      viewerService.setTokenInfo(tokenInfo);

      const accounts = accountManager.loadAllAccounts();
      let immediateConnected = 0;
      let gradualStarted = false;

      // Start immediate viewers first
      if (immediateEnabled && immediateCount > 0) {
        immediateConnected = await viewerService.startImmediate(accounts, immediateCount);
      }

      // Then start gradual mode with remaining accounts
      if (gradualEnabled) {
        const remainingAccounts = accounts.filter(a =>
          !viewerService.isAccountConnected(a.id)
        );
        if (remainingAccounts.length > 0) {
          viewerService.startGradual(remainingAccounts, gradualCount, gradualInterval * 1000);
          gradualStarted = true;
        }
      }

      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ immediateConnected, gradualStarted, tokenInfo }));
      return;
    }

    // POST /api/viewers/stop
    if (pathname === '/api/viewers/stop' && req.method === 'POST') {
      viewerService.disconnectAll();
      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // POST /api/monitor/start - Monitor CA for token creation
    if (pathname === '/api/monitor/start' && req.method === 'POST') {
      const body = await readBody(req);
      const { ca, immediateCount, gradualCount, gradualInterval } = JSON.parse(body);

      if (!ca) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'CA required' }));
        return;
      }

      // Derive pair address from CA
      let pairAddress: string;
      try {
        pairAddress = derivePairAddress(ca);
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid CA: ' + err.message }));
        return;
      }

      monitorCA = ca;
      broadcast('monitor-status', { status: 'monitoring', ca, pairAddress });

      // Start monitoring loop
      if (monitorInterval) clearInterval(monitorInterval);

      monitorInterval = setInterval(async () => {
        if (!monitorCA) return;

        const exists = await checkTokenExists(monitorCA);
        broadcast('monitor-check', { ca: monitorCA, exists });

        if (exists) {
          // Token found! Stop monitoring and start viewers
          clearInterval(monitorInterval!);
          monitorInterval = null;
          const foundCA = monitorCA;
          const foundPair = derivePairAddress(foundCA);
          monitorCA = null;

          broadcast('monitor-status', { status: 'found', ca: foundCA, pairAddress: foundPair });

          // Auto-start viewers
          let tokenInfo = await viewerService.fetchTokenInfo(foundPair);
          if (!tokenInfo) {
            tokenInfo = {
              pairAddress: foundPair,
              tokenAddress: foundCA,
              ticker: 'TOKEN',
              name: 'New Token',
              protocol: 'Pump V1',
              isMigrated: false,
              supply: 1000000000,
              price: 0
            };
          }
          viewerService.setTokenInfo(tokenInfo);

          const accounts = accountManager.loadAllAccounts();

          // Start immediate
          if (immediateCount > 0) {
            await viewerService.startImmediate(accounts, immediateCount);
          }

          // Start gradual with remaining
          if (gradualCount > 0) {
            const remaining = accounts.filter(a => !viewerService.isAccountConnected(a.id));
            if (remaining.length > 0) {
              viewerService.startGradual(remaining, gradualCount, (gradualInterval || 5) * 1000);
            }
          }

          broadcastStatus();
          broadcast('monitor-started-viewers', { tokenInfo });
        }
      }, 1000); // Check every 1 second

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, pairAddress }));
      return;
    }

    // POST /api/monitor/stop
    if (pathname === '/api/monitor/stop' && req.method === 'POST') {
      if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
      }
      monitorCA = null;
      broadcast('monitor-status', { status: 'stopped' });
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // GET /api/derive-pair - Derive pair address from CA
    if (pathname === '/api/derive-pair' && req.method === 'GET') {
      const ca = url.searchParams.get('ca');
      if (!ca) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'ca required' }));
        return;
      }
      try {
        const pairAddress = derivePairAddress(ca);
        res.writeHead(200);
        res.end(JSON.stringify({ ca, pairAddress }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid CA: ' + err.message }));
      }
      return;
    }

    // GET /api/token-info
    if (pathname === '/api/token-info' && req.method === 'GET') {
      const pairAddress = url.searchParams.get('pairAddress');
      if (!pairAddress) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'pairAddress required' }));
        return;
      }
      const tokenInfo = await viewerService.fetchTokenInfo(pairAddress);
      res.writeHead(200);
      res.end(JSON.stringify(tokenInfo || { error: 'Not found' }));
      return;
    }

    // GET /api/proxies
    if (pathname === '/api/proxies' && req.method === 'GET') {
      const stats = proxyManager.getStats();
      res.writeHead(200);
      res.end(JSON.stringify({
        proxies: proxyManager.getProxiesRaw(),
        ...stats
      }));
      return;
    }

    // POST /api/proxies
    if (pathname === '/api/proxies' && req.method === 'POST') {
      const body = await readBody(req);
      const { proxies } = JSON.parse(body);
      const count = proxyManager.setProxies(proxies);
      res.writeHead(200);
      res.end(JSON.stringify({ count }));
      return;
    }

    // POST /api/proxies/check
    if (pathname === '/api/proxies/check' && req.method === 'POST') {
      const result = await proxyManager.checkAllProxies((proxy, ok) => {
        broadcast('proxy-check-result', { proxy, ok });
      });
      const stats = proxyManager.getStats();
      broadcast('proxy-status', stats);
      res.writeHead(200);
      res.end(JSON.stringify({ ...result, total: stats.total }));
      return;
    }

    // POST /api/proxies/reset - Reset used proxies for new session
    if (pathname === '/api/proxies/reset' && req.method === 'POST') {
      proxyManager.resetUsedProxies();
      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, unused: proxyManager.getUnusedCount() }));
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (err: any) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Serve static files
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let filePath = req.url || '/';
  if (filePath === '/') filePath = '/index.html';

  const fullPath = path.join(__dirname, 'public', filePath);
  const ext = path.extname(fullPath);

  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.setHeader('Content-Type', mimeTypes[ext] || 'text/plain');
    res.writeHead(200);
    res.end(data);
  });
}

// Create HTTP server
const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url.startsWith('/api/')) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  uiClients.add(ws);

  // Send initial status
  ws.send(JSON.stringify({
    type: 'status',
    data: {
      accounts: accountManager.getAccountCount(),
      activeViewers: viewerService.getActiveCount(),
      pendingViewers: viewerService.getPendingCount(),
      gradualRunning: viewerService.isGradualRunning(),
    }
  }));

  ws.on('close', () => {
    uiClients.delete(ws);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`\n🚀 Viewer Bot UI running at http://localhost:${PORT}\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  viewerService.disconnectAll();
  server.close();
  process.exit(0);
});
