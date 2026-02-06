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

async function main() {
  console.log('=== Debug Friends Server ===\n');
  console.log(`Token: ${TOKEN}\n`);

  const cookies = loadCookies();
  if (!cookies) {
    console.error('No cookies found');
    process.exit(1);
  }

  const headers = {
    'Origin': 'https://axiom.trade',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Cookie': cookies,
  };

  // Connect to friends server
  console.log('Connecting to friends.axiom.trade...');
  const friends = new WebSocket('wss://friends.axiom.trade/ws', { headers });

  friends.on('open', () => {
    console.log('✅ Friends connected!\n');

    // Start ping
    setInterval(() => {
      if (friends.readyState === WebSocket.OPEN) {
        friends.send('.');
      }
    }, 1000);

    // Try different message formats to see what the server accepts
    console.log('Trying different message formats...\n');

    // Try 1: Join room like cluster
    setTimeout(() => {
      console.log('>>> Sending: join room e-{token}');
      friends.send(JSON.stringify({ action: 'join', room: `e-${TOKEN}` }));
    }, 1000);

    // Try 2: Subscribe format
    setTimeout(() => {
      console.log('>>> Sending: subscribe to token');
      friends.send(JSON.stringify({ action: 'subscribe', token: TOKEN }));
    }, 2000);

    // Try 3: View format
    setTimeout(() => {
      console.log('>>> Sending: view token');
      friends.send(JSON.stringify({ action: 'view', token: TOKEN }));
    }, 3000);

    // Try 4: Watch format
    setTimeout(() => {
      console.log('>>> Sending: watch token');
      friends.send(JSON.stringify({ type: 'watch', tokenAddress: TOKEN }));
    }, 4000);

    // Try 5: Enter room format
    setTimeout(() => {
      console.log('>>> Sending: enter room');
      friends.send(JSON.stringify({ method: 'enter', room: TOKEN }));
    }, 5000);

    // Try 6: Page view format
    setTimeout(() => {
      console.log('>>> Sending: page view');
      friends.send(JSON.stringify({ event: 'pageView', page: `/meme/${TOKEN}` }));
    }, 6000);

    // Try 7: Raw token address
    setTimeout(() => {
      console.log('>>> Sending: raw token address');
      friends.send(TOKEN);
    }, 7000);
  });

  friends.on('message', (data) => {
    const msg = data.toString();
    if (msg !== '.') {
      console.log('<<< RECV:', msg);
    }
  });

  friends.on('error', (err) => {
    console.error('Error:', err.message);
  });

  friends.on('close', () => {
    console.log('Connection closed');
  });

  // Keep running
  await new Promise(r => setTimeout(r, 15000));
  friends.close();
  console.log('\nDone');
}

main().catch(console.error);
