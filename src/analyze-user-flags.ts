/**
 * Hunt for any per-user "eligibility" / "trust" / "volume" flag in the probe.
 *
 * Strategy: look for HTTP responses on user-scoped endpoints (user-data,
 * lighthouse, sharing-config-v2, get-settings, refresh-access-token, etc),
 * print their bodies (CDP only logs response metadata, not body — but
 * request POST bodies and JWT claims are visible), and decode the access-token
 * JWT to surface its claims.
 */

import * as fs from 'fs';

interface Evt { t: number; kind: string; data: any }

const file = process.argv[2];
if (!file) {
  console.error('Usage: tsx src/analyze-user-flags.ts <log.jsonl>');
  process.exit(1);
}

const events: Evt[] = fs.readFileSync(file, 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map(l => { try { return JSON.parse(l) as Evt; } catch { return null; } })
  .filter((x): x is Evt => x !== null);

const userScopedPaths = [
  'user-data',
  'lighthouse',
  'sharing-config-v2',
  'get-settings',
  'get-notifications',
  'refresh-access-token',
  'verify-wallet-v2',
  'wallet-nonce',
  'online-users-count',
  'tracked-wallets-v3',
  'watchlist-v2',
  'bundle-key-and-wallets',
  'user-nonce-accounts',
  'meme-open-positions-v3',
  'top-traders-v5',
];

console.log('=== USER-SCOPED HTTP CALLS ===');
for (const e of events) {
  if (e.kind !== 'http-request') continue;
  const u = e.data.url || '';
  if (!userScopedPaths.some(p => u.includes(p))) continue;
  console.log(`\n+${(e.t/1000).toFixed(1)}s  ${e.data.method}  ${u}`);
  if (e.data.postData) {
    const body = String(e.data.postData);
    console.log('    body: ' + body.slice(0, 500));
  }
  // Show interesting headers
  const h = e.data.headers || {};
  if (h.Authorization || h.authorization) {
    console.log('    auth header: ' + (h.Authorization || h.authorization).slice(0, 80) + '...');
  }
}

console.log('\n\n=== ACCESS TOKEN JWT CLAIMS (decoded) ===');
// Find the access token from any cookie header in any request
const tokens = new Set<string>();
for (const e of events) {
  if (e.kind !== 'http-request' && e.kind !== 'ws-handshake-req') continue;
  const headers = e.data.headers || e.data.request?.headers || {};
  const cookieHeader = headers.Cookie || headers.cookie || '';
  if (!cookieHeader) continue;
  for (const part of String(cookieHeader).split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === 'auth-access-token' && value) tokens.add(value);
  }
}
for (const t of tokens) {
  const [, payloadB64] = t.split('.');
  if (!payloadB64) continue;
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    const payload = JSON.parse(json);
    console.log('  ' + JSON.stringify(payload, null, 2));
  } catch (err: any) {
    console.log('  failed to decode: ' + err.message);
  }
}

console.log('\n\n=== WS HANDSHAKE COOKIES (cluster9 + friends + eucalyptus) ===');
for (const e of events) {
  if (e.kind !== 'ws-handshake-req') continue;
  const url = (events.find(x => x.kind === 'ws-created' && x.data.requestId === e.data.requestId)?.data.url) || '?';
  const headers = e.data.headers || {};
  const cookie = headers.Cookie || headers.cookie || '(none)';
  const cookieNames = cookie === '(none)' ? '(none)' : cookie.split(';').map((s: string) => s.trim().split('=')[0]).join(', ');
  console.log(`  ${url}: cookies=${cookieNames}`);
}
