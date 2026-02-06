import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

// Token to watch
const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';

function loadCookies(): string {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/AXIOM_COOKIES=(.+)/);
    if (match) return match[1].trim();
  }
  return '';
}

// Debug WebSocket client that logs everything
class DebugWsClient {
  private ws: WebSocket | null = null;
  private name: string;
  private url: string;
  private cookies: string;
  private pingInterval: NodeJS.Timeout | null = null;
  private pingFormat: 'json' | 'dot';

  constructor(name: string, url: string, cookies: string, pingFormat: 'json' | 'dot' = 'json') {
    this.name = name;
    this.url = url;
    this.cookies = cookies;
    this.pingFormat = pingFormat;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[${this.name}] Connecting to ${this.url}...`);

      const headers: Record<string, string> = {
        'Origin': 'https://axiom.trade',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      };

      if (this.cookies) {
        headers['Cookie'] = this.cookies;
      }

      this.ws = new WebSocket(this.url, { headers });

      this.ws.on('open', () => {
        console.log(`[${this.name}] ✅ Connected!`);
        this.startPing();
        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = data.toString();
        // Log ALL messages for debugging
        if (!msg.includes('"method":"pong"') && msg !== '.') {
          console.log(`[${this.name}] 📥 RECV:`, msg.slice(0, 300));
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[${this.name}] ❌ Closed: ${code} - ${reason.toString()}`);
      });

      this.ws.on('error', (error) => {
        console.error(`[${this.name}] ⚠️ Error:`, error.message);
        reject(error);
      });
    });
  }

  private startPing() {
    const interval = this.pingFormat === 'dot' ? 1000 : 25000;
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        if (this.pingFormat === 'dot') {
          this.ws.send('.');
        } else {
          this.ws.send(JSON.stringify({ method: 'ping' }));
        }
      }
    }, interval);
  }

  send(data: string | object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      console.log(`[${this.name}] 📤 SEND:`, msg);
      this.ws.send(msg);
    }
  }

  joinRoom(room: string) {
    this.send({ action: 'join', room });
  }

  disconnect() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    this.ws?.close();
  }
}

async function main() {
  console.log('=== Axiom Debug Viewer ===\n');
  console.log(`Token: ${TOKEN}\n`);

  const cookies = loadCookies();
  if (!cookies) {
    console.error('No cookies found. Run "npm run login" first.');
    process.exit(1);
  }

  // Create clients for all servers
  const cluster = new DebugWsClient('CLUSTER', 'wss://cluster8.axiom.trade/', cookies, 'json');
  const eucalyptus = new DebugWsClient('EUCALYPTUS', 'wss://eucalyptus.axiom.trade/ws', cookies, 'json');
  const friends = new DebugWsClient('FRIENDS', 'wss://friends.axiom.trade/ws', cookies, 'dot');

  try {
    // Connect all
    await Promise.all([
      cluster.connect(),
      eucalyptus.connect(),
      friends.connect(),
    ]);

    console.log('\n=== All connected, subscribing to rooms ===\n');

    // Wait a bit for connections to stabilize
    await new Promise(r => setTimeout(r, 1000));

    // Subscribe to token rooms on cluster (like browser does)
    console.log('\n--- Cluster subscriptions ---');
    cluster.joinRoom(`t:${TOKEN}`);
    await new Promise(r => setTimeout(r, 100));
    cluster.joinRoom(`f:${TOKEN}`);
    await new Promise(r => setTimeout(r, 100));
    cluster.joinRoom(`td:${TOKEN}`);
    await new Promise(r => setTimeout(r, 100));
    cluster.joinRoom(`s:${TOKEN}`);
    await new Promise(r => setTimeout(r, 100));
    cluster.joinRoom(`e:${TOKEN}`);

    // Subscribe to viewer count room on eucalyptus
    console.log('\n--- Eucalyptus subscription ---');
    await new Promise(r => setTimeout(r, 500));
    eucalyptus.joinRoom(`e-${TOKEN}`);

    // Keep running and observe
    console.log('\n=== Watching for messages (30 seconds)... ===\n');

    await new Promise(r => setTimeout(r, 30000));

    console.log('\n=== Disconnecting ===');
    cluster.disconnect();
    eucalyptus.disconnect();
    friends.disconnect();

  } catch (err) {
    console.error('Error:', err);
  }
}

main().catch(console.error);
