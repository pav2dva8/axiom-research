/**
 * Find which WS connection delivers the viewer-count data and which "room"
 * the count is broadcast on. Search every received frame for clues.
 */

import * as fs from 'fs';

const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
interface Evt { t: number; kind: string; data: any; }
const events: Evt[] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Evt[];

const wsMeta: Record<string, string> = {};
for (const e of events) if (e.kind === 'ws-created') wsMeta[e.data.requestId] = e.data.url;

// Group RECV by URL, count per-room frequency
const roomCountsByUrl: Record<string, Record<string, number>> = {};
const roomSamples: Record<string, string> = {};
for (const e of events) {
  if (e.kind !== 'ws-recv') continue;
  const url = wsMeta[e.data.requestId] || 'unknown';
  let room: string | null = null;
  let parsed: any = null;
  try {
    parsed = JSON.parse(e.data.payload);
    if (parsed.room) room = parsed.room;
    else if (parsed.type) room = `type:${parsed.type}`;
  } catch {
    room = `raw:${e.data.payload.slice(0, 30)}`;
  }
  if (!room) continue;
  if (!roomCountsByUrl[url]) roomCountsByUrl[url] = {};
  roomCountsByUrl[url][room] = (roomCountsByUrl[url][room] || 0) + 1;
  if (!roomSamples[`${url}::${room}`]) roomSamples[`${url}::${room}`] = e.data.payload.slice(0, 280);
}

console.log('=== ROOMS / TYPES SEEN PER WS CONNECTION ===');
for (const [url, counts] of Object.entries(roomCountsByUrl)) {
  console.log(`\n${url}`);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [room, count] of sorted) {
    const sample = roomSamples[`${url}::${room}`] || '';
    console.log(`  [${count}] ${room}`);
    console.log(`     sample: ${sample}`);
  }
}

// Now look for ANY frame containing "view", "eye", "count", "presence", "watch"
console.log('\n\n=== FRAMES CONTAINING VIEWER-RELATED KEYWORDS ===');
const keywords = ['eye', 'view', 'watch', 'presence', 'pageView', 'visitor', 'pageUsers', 'userCount'];
for (const e of events) {
  if (e.kind !== 'ws-recv' && e.kind !== 'ws-sent') continue;
  const p = e.data.payload || '';
  for (const k of keywords) {
    if (p.toLowerCase().includes(k.toLowerCase())) {
      console.log(`+${(e.t/1000).toFixed(1)}s ${e.kind} on ${wsMeta[e.data.requestId]}`);
      console.log('   ' + p.slice(0, 300));
      break;
    }
  }
}

// Print every unique "room" name we ever saw
console.log('\n\n=== ALL UNIQUE ROOMS (from RECV frames) ===');
const allRooms = new Set<string>();
for (const e of events) {
  if (e.kind !== 'ws-recv') continue;
  try {
    const p = JSON.parse(e.data.payload);
    if (p.room) allRooms.add(p.room);
  } catch {}
}
[...allRooms].sort().forEach(r => console.log('  ' + r));

// All sent messages on eucalyptus and friends (full)
console.log('\n\n=== ALL SENT FRAMES ON EUCALYPTUS AND FRIENDS ===');
for (const e of events) {
  if (e.kind !== 'ws-sent') continue;
  const url = wsMeta[e.data.requestId] || 'unknown';
  if (!url.includes('eucalyptus') && !url.includes('friends')) continue;
  const p = e.data.payload;
  if (p === '.' || p === '{"method":"ping"}') continue; // skip pings
  console.log(`+${(e.t/1000).toFixed(1)}s ${url}: ${p.slice(0, 400)}`);
}
