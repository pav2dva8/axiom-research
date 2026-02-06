/**
 * Full Viewer Test - Connect to ALL servers like the browser does
 *
 * Based on code analysis, the browser connects to:
 * 1. Cluster server - main trading data, token subscriptions
 * 2. Eucalyptus server - viewer count with user-id param
 * 3. Friends server - social/presence (pings with ".")
 *
 * This script mimics the exact browser behavior to test viewer counting.
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.error('No .env file. Run "npm run login" first.');
    process.exit(1);
  }

  const envContent = fs.readFileSync(envPath, 'utf-8');
  const cookieMatch = envContent.match(/AXIOM_COOKIES=(.+)/);
  const accessTokenMatch = envContent.match(/AXIOM_ACCESS_TOKEN=([^\s]+)/);

  if (!cookieMatch) {
    console.error('No cookies in .env');
    process.exit(1);
  }

  let userId = '';
  if (accessTokenMatch) {
    try {
      const payload = accessTokenMatch[1].split('.')[1];
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
      userId = decoded.authenticatedUserId;
    } catch {}
  }

  return { cookies: cookieMatch[1].trim(), userId };
}

class WebSocketClient {
  protected ws: WebSocket | null = null;
  protected pingTimer: NodeJS.Timeout | null = null;
  public name: string;

  constructor(name: string) {
    this.name = name;
  }

  protected log(...args: unknown[]) {
    console.log(`[${this.name}]`, ...args);
  }

  disconnect() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
  }
}

class ClusterClient extends WebSocketClient {
  constructor() {
    super('Cluster');
  }

  connect(cookies: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = 'wss://cluster8.axiom.trade/';
      this.log(`Connecting to ${wsUrl}`);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Origin': 'https://axiom.trade',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Cookie': cookies,
        }
      });

      this.ws.on('open', () => {
        this.log('Connected!');

        // Ping every 25 seconds
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ method: 'ping' }));
          }
        }, 25000);

        // Subscribe to ALL token rooms like the browser does
        const rooms = [
          `t:${token}`,   // Token room
          `f:${token}`,   // Feed room
          `td:${token}`,  // Token details
          `s:${token}`,   // Subscribers
          `e:${token}`,   // Events (NOTE: this is e: not e- !)
        ];

        rooms.forEach(room => {
          this.log(`Joining room: ${room}`);
          this.ws!.send(JSON.stringify({ action: 'join', room }));
        });

        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = data.toString();
        if (msg !== '{"method":"pong"}') {
          try {
            const parsed = JSON.parse(msg);
            if (parsed.room) {
              this.log(`Room ${parsed.room}: ${JSON.stringify(parsed.content).slice(0, 100)}`);
            }
          } catch {
            this.log('Message:', msg.slice(0, 100));
          }
        }
      });

      this.ws.on('error', (err) => {
        this.log('Error:', err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        this.log('Disconnected');
      });
    });
  }
}

class EucalyptusClient extends WebSocketClient {
  constructor() {
    super('Eucalyptus');
  }

  connect(cookies: string, userId: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // IMPORTANT: Include user-id in query params!
      const wsUrl = `wss://eucalyptus.axiom.trade/ws?user-id=${userId}`;
      this.log(`Connecting to ${wsUrl}`);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Origin': 'https://axiom.trade',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Cookie': cookies,
        }
      });

      this.ws.on('open', () => {
        this.log('Connected!');

        // Ping every 30 seconds
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ method: 'ping' }));
          }
        }, 30000);

        // Join viewer count room (e- prefix)
        const viewerRoom = `e-${token}`;
        this.log(`Joining room: ${viewerRoom}`);
        this.ws!.send(JSON.stringify({ action: 'join', room: viewerRoom }));

        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = data.toString();
        if (msg !== '{"method":"pong"}') {
          this.log('RECV:', msg);
          try {
            const parsed = JSON.parse(msg);
            if (parsed.room?.startsWith('e-')) {
              console.log(`\n>>> VIEWER COUNT: ${parsed.content} <<<\n`);
            }
          } catch {}
        }
      });

      this.ws.on('error', (err) => {
        this.log('Error:', err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        this.log('Disconnected');
      });
    });
  }
}

class FriendsClient extends WebSocketClient {
  constructor() {
    super('Friends');
  }

  connect(cookies: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = 'wss://friends.axiom.trade/ws';
      this.log(`Connecting to ${wsUrl}`);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Origin': 'https://axiom.trade',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Cookie': cookies,
        }
      });

      this.ws.on('open', () => {
        this.log('Connected!');

        // Friends server uses "." as ping every 1 second
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send('.');
          }
        }, 1000);

        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = data.toString();
        if (msg !== '.') {
          this.log('RECV:', msg);
        }
      });

      this.ws.on('error', (err) => {
        this.log('Error:', err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        this.log('Disconnected');
      });
    });
  }
}

async function main() {
  console.log('=== Full Viewer Test ===');
  console.log(`Token: ${TOKEN}\n`);

  const { cookies, userId } = loadEnv();

  if (!userId) {
    console.error('No userId found in access token. Re-run "npm run login".');
    process.exit(1);
  }

  console.log(`User ID: ${userId}\n`);

  const cluster = new ClusterClient();
  const eucalyptus = new EucalyptusClient();
  const friends = new FriendsClient();

  try {
    // Connect to all three servers simultaneously (like the browser)
    console.log('Connecting to all servers...\n');

    await Promise.all([
      cluster.connect(cookies, TOKEN),
      eucalyptus.connect(cookies, userId, TOKEN),
      friends.connect(cookies),
    ]);

    console.log('\n=== All connections established ===');
    console.log('Monitoring for viewer count updates...');
    console.log('Try refreshing the browser page to see if count changes.\n');
    console.log('Press Ctrl+C to exit\n');

    // Keep running
    await new Promise(() => {});
  } catch (err) {
    console.error('Connection failed:', err);
  }

  process.on('SIGINT', () => {
    console.log('\nDisconnecting all...');
    cluster.disconnect();
    eucalyptus.disconnect();
    friends.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
