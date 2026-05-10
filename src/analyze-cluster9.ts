/**
 * Examine every SENT frame on cluster9 (the room-pubsub server) to learn
 * the join protocol and whether the e-room is joined explicitly.
 */

import * as fs from 'fs';
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
interface Evt { t: number; kind: string; data: any; }
const events: Evt[] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Evt[];

const wsMeta: Record<string, string> = {};
for (const e of events) if (e.kind === 'ws-created') wsMeta[e.data.requestId] = e.data.url;

console.log('=== ALL SENT FRAMES ON cluster9 ===');
let count = 0;
for (const e of events) {
  if (e.kind !== 'ws-sent') continue;
  const url = wsMeta[e.data.requestId] || 'unknown';
  if (!url.includes('cluster')) continue;
  const p = e.data.payload;
  if (p === '{"method":"ping"}' || p === '.') continue;
  count++;
  console.log(`+${(e.t/1000).toFixed(1)}s req=${e.data.requestId}: ${p.slice(0, 320)}`);
}
console.log(`\nTotal non-ping sent: ${count}`);

console.log('\n\n=== HANDSHAKE for cluster9 ===');
for (const e of events) {
  if (e.kind !== 'ws-handshake-req') continue;
  const url = wsMeta[e.data.requestId] || '';
  if (!url.includes('cluster')) continue;
  console.log(`req=${e.data.requestId} url=${url}`);
  const h = e.data.headers || {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === 'string') console.log(`   ${k}: ${v.length > 200 ? v.slice(0, 200)+'...' : v}`);
  }
}

console.log('\n\n=== Frames received on cluster9 with the e-{pair} room ===');
for (const e of events) {
  if (e.kind !== 'ws-recv') continue;
  const url = wsMeta[e.data.requestId] || 'unknown';
  if (!url.includes('cluster')) continue;
  if (!e.data.payload.includes('e-')) continue;
  if (!e.data.payload.includes('Amk61ySm')) continue;
  console.log(`+${(e.t/1000).toFixed(1)}s: ${e.data.payload.slice(0, 300)}`);
}

// Look for any "subscribe" / "join" / room-related send near the navigation to the token page
console.log('\n\n=== ALL SENT FRAMES NEAR THE TOKEN-PAGE NAVIGATION ===');
const navStart = events.find(e => e.kind === 'navigated' && e.data?.url?.includes('Amk61ySm'))?.t ?? 0;
console.log('Navigation timestamp: +' + (navStart/1000).toFixed(1) + 's');
const window = 25_000; // ms
for (const e of events) {
  if (e.kind !== 'ws-sent') continue;
  if (Math.abs(e.t - navStart) > window) continue;
  const url = wsMeta[e.data.requestId] || '';
  const p = e.data.payload;
  if (p === '.' || p === '{"method":"ping"}') continue;
  console.log(`+${(e.t/1000).toFixed(1)}s [${url.split('/')[2]}] ${p.slice(0, 320)}`);
}
