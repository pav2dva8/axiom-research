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
const VIEWER_DELAY_MS = 100;

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
  });
}

viewerService.on('viewer-connected', () => broadcastStatus());
viewerService.on('viewer-disconnected', () => broadcastStatus());

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
      }));
      return;
    }

    // GET /api/accounts
    if (pathname === '/api/accounts' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify(accountManager.listAccounts()));
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

      const success = await accountManager.reloginAllAccounts((done, total, message) => {
        broadcast('relogin-progress', { done, total, message });
      });

      // Pass browser session to viewer service for WS connections
      const session = accountManager.getBrowserSession();
      viewerService.setBrowserSession(session || null);

      const total = accountManager.getAccountCount();
      broadcastStatus();
      res.end(JSON.stringify({ success, total }));
      return;
    }

    // POST /api/accounts/relogin/stop
    if (pathname === '/api/accounts/relogin/stop' && req.method === 'POST') {
      accountManager.stopReloginAll();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // POST /api/viewers/start
    if (pathname === '/api/viewers/start' && req.method === 'POST') {
      const body = await readBody(req);
      const { pairAddress } = JSON.parse(body);

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
      const connected = await viewerService.connectAll(accounts, VIEWER_DELAY_MS);

      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ connected, tokenInfo }));
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
  // SPA fallback: serve index.html for any path without a file extension
  const hasExt = path.extname(filePath).length > 0;
  if (!hasExt) filePath = '/index.html';

  const WEB_DIST = path.join(process.cwd(), 'src/ui/web/dist');
  const fullPath = path.join(WEB_DIST, filePath);
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
