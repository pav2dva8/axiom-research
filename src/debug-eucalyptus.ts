import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

// Token to watch
const TOKEN = process.argv[2] || '6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG';

function loadEnv(): { cookies: string; userId: string } {
  const envPath = path.join(process.cwd(), '.env');
  let cookies = '';
  let userId = '';

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const cookieMatch = envContent.match(/AXIOM_COOKIES=(.+)/);
    if (cookieMatch) cookies = cookieMatch[1].trim();

    // First try to get userId from env variable (this is what browser uses from localStorage)
    const userIdMatch = envContent.match(/AXIOM_USER_ID=([^\s]+)/);
    if (userIdMatch) {
      userId = userIdMatch[1].trim();
      console.log('[Using AXIOM_USER_ID from .env]');
    } else {
      // Fall back to extracting from access token JWT
      const accessTokenMatch = envContent.match(/AXIOM_ACCESS_TOKEN=([^\s]+)/);
      if (accessTokenMatch) {
        try {
          const payload = accessTokenMatch[1].split('.')[1];
          const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
          userId = decoded.authenticatedUserId;
          console.log('[Using authenticatedUserId from JWT token]');
        } catch (e) {
          console.error('Failed to decode access token');
        }
      }
    }
  }

  return { cookies, userId };
}

async function main() {
  console.log('=== Debug Eucalyptus Server ===\n');
  console.log(`Token: ${TOKEN}\n`);

  const { cookies, userId } = loadEnv();

  if (!cookies) {
    console.error('No cookies found. Run "npm run login" first.');
    process.exit(1);
  }

  if (!userId) {
    console.error('No userId found in access token.');
    process.exit(1);
  }

  console.log(`User ID: ${userId}\n`);

  const headers = {
    'Origin': 'https://axiom.trade',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Cookie': cookies,
  };

  // Connect to eucalyptus WITH user-id query param (key finding from code analysis!)
  const wsUrl = `wss://eucalyptus.axiom.trade/ws?user-id=${userId}`;
  console.log(`Connecting to: ${wsUrl}\n`);

  const ws = new WebSocket(wsUrl, { headers });

  ws.on('open', () => {
    console.log('Connected to eucalyptus!\n');

    // Start ping every 30 seconds (like the browser code does)
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, 30000);

    // Join the viewer count room for the token
    const viewerRoom = `e-${TOKEN}`;
    console.log(`Joining room: ${viewerRoom}`);
    ws.send(JSON.stringify({ action: 'join', room: viewerRoom }));

    // Also try other room formats
    setTimeout(() => {
      console.log(`Trying room: sol-${TOKEN}`);
      ws.send(JSON.stringify({ action: 'join', room: `sol-${TOKEN}` }));
    }, 2000);
  });

  ws.on('message', (data) => {
    const msg = data.toString();
    const timestamp = new Date().toISOString();

    // Skip pong messages
    if (msg === '{"method":"pong"}') {
      return;
    }

    console.log(`[${timestamp}] RECV:`, msg);

    // Try to parse and check for viewer count
    try {
      const parsed = JSON.parse(msg);
      if (parsed.room?.startsWith('e-')) {
        console.log(`\n>>> VIEWER COUNT: ${parsed.content} <<<\n`);
      }
    } catch (e) {
      // Not JSON
    }
  });

  ws.on('error', (err) => {
    console.error('Error:', err.message);
  });

  ws.on('close', (code, reason) => {
    console.log(`Connection closed: ${code} - ${reason.toString()}`);
  });

  // Keep running
  console.log('\nWaiting for messages... (Ctrl+C to exit)\n');

  process.on('SIGINT', () => {
    console.log('\nClosing connection...');
    ws.close();
    process.exit(0);
  });
}

main().catch(console.error);
