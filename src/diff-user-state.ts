/**
 * Diff two probe runs by per-endpoint response body.
 *
 * Use this AFTER running `npm run probe` once with a NEW (uncounted) account
 * and once with an OLD (counting) account. Pass both log files and we'll
 * surface every endpoint where the bodies differ — the viewer-eligibility
 * flag will be one of the deltas.
 *
 * Usage:
 *   tsx src/diff-user-state.ts probe-logs/probe-XXXX.jsonl probe-logs/probe-YYYY.jsonl
 */

import * as fs from 'fs';

interface Evt { t: number; kind: string; data: any }

const [, , fileA, fileB] = process.argv;
if (!fileA || !fileB) {
  console.error('Usage: tsx src/diff-user-state.ts <logA.jsonl> <logB.jsonl>');
  process.exit(1);
}

function load(file: string): Map<string, any> {
  const events: Evt[] = fs.readFileSync(file, 'utf-8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) as Evt; } catch { return null; } })
    .filter((x): x is Evt => x !== null);

  const out = new Map<string, any>();
  for (const e of events) {
    if (e.kind !== 'http-body') continue;
    const u = new URL(e.data.url);
    const path = u.host + u.pathname;
    let parsed: any = e.data.body;
    try { parsed = JSON.parse(e.data.body); } catch {}
    // Last-write-wins per path so we always show the latest body
    out.set(path, parsed);
  }
  return out;
}

function tagAccount(file: string, bodies: Map<string, any>): string {
  // Try to extract our own publicKey from any body that includes a wallet.
  // user-data often returns userId + walletAddress.
  const ud = bodies.get('api9.axiom.trade/user-data') ?? bodies.get('api2.axiom.trade/user-data');
  if (ud && typeof ud === 'object') {
    const w = (ud as any).walletAddress || (ud as any).publicKey || (ud as any).address;
    if (w) return `${file}  (wallet=${String(w).slice(0, 8)}…)`;
  }
  return file;
}

const A = load(fileA);
const B = load(fileB);

console.log('A:', tagAccount(fileA, A));
console.log('B:', tagAccount(fileB, B));

const allPaths = new Set<string>([...A.keys(), ...B.keys()]);
for (const p of [...allPaths].sort()) {
  const a = A.get(p);
  const b = B.get(p);
  const aJson = JSON.stringify(a, null, 2);
  const bJson = JSON.stringify(b, null, 2);
  if (aJson === bJson) {
    console.log(`\n[same]  ${p}`);
    continue;
  }
  console.log(`\n[DIFF]  ${p}`);
  if (a === undefined) {
    console.log('   A: <not captured>');
  } else {
    console.log('   A:');
    aJson.split('\n').slice(0, 80).forEach(l => console.log('     ' + l));
  }
  if (b === undefined) {
    console.log('   B: <not captured>');
  } else {
    console.log('   B:');
    bJson.split('\n').slice(0, 80).forEach(l => console.log('     ' + l));
  }
}

// Also list keys per-body that exist in only one side, for shallow JSON
console.log('\n\n=== SHALLOW KEY DIFFS (object responses) ===');
for (const p of [...allPaths].sort()) {
  const a = A.get(p);
  const b = B.get(p);
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') continue;
  if (Array.isArray(a) || Array.isArray(b)) continue;
  const ka = new Set(Object.keys(a));
  const kb = new Set(Object.keys(b));
  const onlyA = [...ka].filter(k => !kb.has(k));
  const onlyB = [...kb].filter(k => !ka.has(k));
  if (onlyA.length === 0 && onlyB.length === 0) {
    // also surface differing values per shared key
    const differing = [...ka].filter(k => kb.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    if (differing.length === 0) continue;
    console.log(`\n${p}  (same keys, differing values)`);
    for (const k of differing) {
      console.log(`  ${k}:`);
      console.log(`    A = ${JSON.stringify(a[k])?.slice(0, 200)}`);
      console.log(`    B = ${JSON.stringify(b[k])?.slice(0, 200)}`);
    }
  } else {
    console.log(`\n${p}`);
    if (onlyA.length) console.log('  only in A:', onlyA.join(', '));
    if (onlyB.length) console.log('  only in B:', onlyB.join(', '));
  }
}
