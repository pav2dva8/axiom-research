/**
 * Multi-Viewer Test Script
 *
 * Tests the theory that viewer count is based on unique authenticated users
 * connected to the eucalyptus WebSocket with the same token room.
 *
 * Usage: npx tsx src/multi-viewer-test.ts [tokenAddress]
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';

interface AuthInfo {
  cookies: string;
  userId: string;
  name: string;
}

function loadPrimaryAuth(): AuthInfo | null {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return null;

  const envContent = fs.readFileSync(envPath, 'utf-8');
  const cookieMatch = envContent.match(/AXIOM_COOKIES=(.+)/);
  const accessTokenMatch = envContent.match(/AXIOM_ACCESS_TOKEN=([^\s]+)/);

  if (!cookieMatch || !accessTokenMatch) return null;

  try {
    const payload = accessTokenMatch[1].split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    return {
      cookies: cookieMatch[1].trim(),
      userId: decoded.authenticatedUserId,
      name: 'Primary'
    };
  } catch {
    return null;
  }
}

class EucalyptusViewer {
  private ws: WebSocket | null = null;
  private auth: AuthInfo;
  private token: string;
  private pingTimer: NodeJS.Timeout | null = null;
  public isConnected = false;

  constructor(auth: AuthInfo, token: string) {
    this.auth = auth;
    this.token = token;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://eucalyptus.axiom.trade/ws?user-id=${this.auth.userId}`;

      console.log(`[${this.auth.name}] Connecting with user-id: ${this.auth.userId.slice(0, 8)}...`);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Origin': 'https://axiom.trade',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Cookie': this.auth.cookies,
        }
      });

      this.ws.on('open', () => {
        console.log(`[${this.auth.name}] Connected!`);
        this.isConnected = true;

        // Start ping
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ method: 'ping' }));
          }
        }, 30000);

        // Join viewer room
        const room = `e-${this.token}`;
        console.log(`[${this.auth.name}] Joining room: ${room}`);
        this.ws.send(JSON.stringify({ action: 'join', room }));

        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = data.toString();
        if (msg !== '{"method":"pong"}') {
          const timestamp = new Date().toISOString();
          console.log(`[${this.auth.name}] ${timestamp} RECV:`, msg);

          try {
            const parsed = JSON.parse(msg);
            if (parsed.room?.startsWith('e-')) {
              console.log(`\n>>> [${this.auth.name}] VIEWER COUNT: ${parsed.content} <<<\n`);
            }
          } catch {}
        }
      });

      this.ws.on('error', (err) => {
        console.error(`[${this.auth.name}] Error:`, err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        console.log(`[${this.auth.name}] Disconnected`);
        this.isConnected = false;
        if (this.pingTimer) clearInterval(this.pingTimer);
      });
    });
  }

  disconnect() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

async function main() {
  console.log('=== Multi-Viewer Test ===\n');
  console.log(`Token: ${TOKEN}\n`);

  const primaryAuth = loadPrimaryAuth();
  if (!primaryAuth) {
    console.error('No auth found. Run "npm run login" first.');
    process.exit(1);
  }

  console.log('Creating viewer connection...\n');

  const viewer = new EucalyptusViewer(primaryAuth, TOKEN);

  try {
    await viewer.connect();

    console.log('\n=== Connection Status ===');
    console.log(`Viewer connected: ${viewer.isConnected}`);
    console.log('\nWaiting for viewer count updates...');
    console.log('(The server may only send updates when count changes)');
    console.log('(Try opening/closing the token page in your browser to trigger updates)\n');
    console.log('Press Ctrl+C to exit\n');

    // Keep running
    await new Promise(() => {});
  } catch (err) {
    console.error('Failed to connect:', err);
  }

  process.on('SIGINT', () => {
    console.log('\nDisconnecting...');
    viewer.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
