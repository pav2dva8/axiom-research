/**
 * Viewer Bot Web Server
 *
 * Simple HTTP server with WebSocket for real-time updates
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { AccountManager } from './account-manager';
import { ViewerService } from './viewer-service';

const PORT = process.env.PORT || 3847;

const accountManager = new AccountManager();
const viewerService = new ViewerService();

// Track connected UI clients
const uiClients: Set<WebSocket> = new Set();

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

      let created = 0;
      for (let i = 0; i < count; i++) {
        const account = await accountManager.createAccount();
        if (account) {
          created++;
          broadcast('account-created', { created, total: count });
        }
        await new Promise(r => setTimeout(r, 500));
      }

      broadcastStatus();
      res.end(JSON.stringify({ created }));
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

    // POST /api/viewers/start
    if (pathname === '/api/viewers/start' && req.method === 'POST') {
      const body = await readBody(req);
      const { pairAddress, mode, count, viewersPerInterval, intervalSeconds } = JSON.parse(body);

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

      if (mode === 'immediate') {
        const connected = await viewerService.startImmediate(accounts, count);
        broadcastStatus();
        res.writeHead(200);
        res.end(JSON.stringify({ connected, tokenInfo }));
      } else if (mode === 'gradual') {
        viewerService.startGradual(accounts, viewersPerInterval, intervalSeconds * 1000);
        broadcastStatus();
        res.writeHead(200);
        res.end(JSON.stringify({ started: true, tokenInfo }));
      } else {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid mode' }));
      }
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
