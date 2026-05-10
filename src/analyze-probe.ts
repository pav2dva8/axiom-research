/**
 * Analyzes a probe-token-page log: extracts everything about the eucalyptus
 * and friends WS connections plus auth-related HTTP calls.
 */

import * as fs from 'fs';
import * as path from 'path';

interface LogLine { t: number; kind: string; data: any; }

const file = process.argv[2];
if (!file) { console.error('Usage: tsx src/analyze-probe.ts <logfile>'); process.exit(1); }

const PAIR = process.argv[3] || 'Amk61ySm6z9hWSRSEsCKiMMb3i1G8ph89wNP9FzhBzsN';

const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
const events: LogLine[] = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }

console.log(`Total events: ${events.length}`);

// 1. WS endpoints + handshake details
const wsByReq: Record<string, { url: string; reqHeaders?: any; respStatus?: number; respHeaders?: any; sent: string[]; recv: string[]; }>= {};
for (const e of events) {
  if (e.kind === 'ws-created') {
    wsByReq[e.data.requestId] = { url: e.data.url, sent: [], recv: [] };
  }
  if (e.kind === 'ws-handshake-req' && wsByReq[e.data.requestId]) {
    wsByReq[e.data.requestId].reqHeaders = e.data.headers;
  }
  if (e.kind === 'ws-handshake-resp' && wsByReq[e.data.requestId]) {
    wsByReq[e.data.requestId].respStatus = e.data.status;
    wsByReq[e.data.requestId].respHeaders = e.data.headers;
  }
  if (e.kind === 'ws-sent' && wsByReq[e.data.requestId]) {
    wsByReq[e.data.requestId].sent.push(e.data.payload);
  }
  if (e.kind === 'ws-recv' && wsByReq[e.data.requestId]) {
    wsByReq[e.data.requestId].recv.push(e.data.payload);
  }
}

console.log('\n=========== ALL WS ENDPOINTS ==========');
for (const [id, ws] of Object.entries(wsByReq)) {
  console.log(`\n--- ${id}  ${ws.url}  (status=${ws.respStatus})`);
  console.log(`  cookie header included: ${!!ws.reqHeaders?.Cookie}`);
  console.log(`  sent=${ws.sent.length} recv=${ws.recv.length}`);
}

// 2. EUCALYPTUS DEEP DIVE
console.log('\n\n=========== EUCALYPTUS DETAIL ==========');
for (const [id, ws] of Object.entries(wsByReq)) {
  if (!ws.url.includes('eucalyptus')) continue;
  console.log(`\n>>> ${ws.url}`);
  console.log('  Handshake REQ headers:');
  for (const [k, v] of Object.entries(ws.reqHeaders || {})) {
    if (typeof v === 'string') console.log(`    ${k}: ${v.length > 120 ? v.slice(0, 120)+'...' : v}`);
  }
  console.log('  Handshake RESP status:', ws.respStatus);
  console.log('  First 30 SENT frames:');
  for (const f of ws.sent.slice(0, 30)) console.log('    →', f.slice(0, 220));
  console.log('  First 60 RECV frames:');
  for (const f of ws.recv.slice(0, 60)) console.log('    ←', f.slice(0, 220));
  // Print all unique sent frame "shapes"
  const shapes = new Set<string>();
  for (const f of ws.sent) {
    try {
      const j = JSON.parse(f);
      const shape = JSON.stringify(Object.keys(j).sort());
      shapes.add(shape + '  example=' + JSON.stringify(j).slice(0, 200));
    } catch { shapes.add('raw: ' + f.slice(0, 80)); }
  }
  console.log('  UNIQUE SENT shapes:');
  for (const s of shapes) console.log('    -', s);
  // Look for messages mentioning the pair address
  console.log('  Frames mentioning the pair address:');
  for (const f of [...ws.sent, ...ws.recv]) {
    if (f.includes(PAIR.slice(0, 12))) console.log('    *', f.slice(0, 300));
  }
}

// 3. FRIENDS DEEP DIVE
console.log('\n\n=========== FRIENDS DETAIL ==========');
for (const [id, ws] of Object.entries(wsByReq)) {
  if (!ws.url.includes('friends')) continue;
  console.log(`\n>>> ${ws.url}`);
  console.log('  Handshake REQ headers:');
  for (const [k, v] of Object.entries(ws.reqHeaders || {})) {
    if (typeof v === 'string') console.log(`    ${k}: ${v.length > 120 ? v.slice(0, 120)+'...' : v}`);
  }
  console.log('  Handshake RESP status:', ws.respStatus);
  // Filter out '.' pings to make output readable
  const nonDotSent = ws.sent.filter(f => f !== '.');
  const nonDotRecv = ws.recv.filter(f => f !== '.');
  console.log(`  total SENT=${ws.sent.length} (non-'.': ${nonDotSent.length})`);
  console.log(`  total RECV=${ws.recv.length} (non-'.': ${nonDotRecv.length})`);
  console.log('  Non-dot SENT frames:');
  for (const f of nonDotSent.slice(0, 50)) console.log('    →', f.slice(0, 300));
  console.log('  Non-dot RECV frames:');
  for (const f of nonDotRecv.slice(0, 50)) console.log('    ←', f.slice(0, 300));
  console.log('  Frames mentioning the pair address:');
  for (const f of [...ws.sent, ...ws.recv]) {
    if (f.includes(PAIR.slice(0, 12))) console.log('    *', f.slice(0, 400));
  }
}

// 4. HTTP requests to api2/api/api9 — anything that might be a viewer-registration call
console.log('\n\n=========== HTTP API CALLS (api/api2/api3/api9) ==========');
const apiCalls = events.filter(e => e.kind === 'http-request' && /api[0-9]?\.axiom\.trade/.test(e.data.url));
const byPath: Record<string, { count: number; methods: Set<string>; samplePost?: string; sampleHeaders?: any }> = {};
for (const e of apiCalls) {
  const u = new URL(e.data.url);
  const key = u.host + u.pathname;
  if (!byPath[key]) byPath[key] = { count: 0, methods: new Set(), sampleHeaders: e.data.headers };
  byPath[key].count++;
  byPath[key].methods.add(e.data.method);
  if (e.data.postData && !byPath[key].samplePost) byPath[key].samplePost = String(e.data.postData).slice(0, 300);
}
const sorted = Object.entries(byPath).sort((a, b) => b[1].count - a[1].count);
console.log(`Total api calls: ${apiCalls.length}`);
for (const [p, info] of sorted) {
  console.log(`\n  [${info.count}] ${[...info.methods].join('/')}  ${p}`);
  if (info.samplePost) console.log(`    sample POST body: ${info.samplePost}`);
}

// 5. Look for anything URL-or-body containing the pair address
console.log('\n\n=========== HTTP CALLS MENTIONING THE PAIR ==========');
for (const e of events) {
  if (e.kind !== 'http-request') continue;
  const u = e.data.url || '';
  const body = e.data.postData || '';
  if (u.includes(PAIR.slice(0, 12)) || body.includes(PAIR.slice(0, 12))) {
    console.log(`+${(e.t/1000).toFixed(1)}s ${e.data.method} ${u}`);
    if (body) console.log(`    body: ${String(body).slice(0, 300)}`);
    if (e.data.headers?.Cookie) console.log('    has Cookie header');
    if (e.data.headers?.Authorization) console.log('    has Authorization header');
  }
}

// 6. WS handshake URLs in chronological order (so we see the order operations happen)
console.log('\n\n=========== WS CONNECTION TIMELINE ==========');
for (const e of events) {
  if (e.kind === 'ws-created') {
    console.log(`+${(e.t/1000).toFixed(1)}s WS ${e.data.url}`);
  }
  if (e.kind === 'ws-handshake-resp') {
    console.log(`+${(e.t/1000).toFixed(1)}s   handshake response ${e.data.status} ${e.data.statusText}`);
  }
}

// 7. eucalyptus connection details
console.log('\n\n=========== EUCALYPTUS HANDSHAKE COOKIE/AUTH ==========');
for (const [id, ws] of Object.entries(wsByReq)) {
  if (!ws.url.includes('eucalyptus')) continue;
  const cookie = ws.reqHeaders?.Cookie || '';
  const named = cookie.split(';').map((c: string) => c.trim().split('=')[0]).filter(Boolean);
  console.log(`  ${ws.url}: cookies=${named.join(', ')}`);
}
