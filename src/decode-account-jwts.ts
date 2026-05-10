/**
 * Decode every cached JWT in accounts/tokens/ and print its claims side-by-side.
 * The "viewer eligibility" flag — if it lives in a JWT — will be a field that
 * differs between counted vs uncounted accounts.
 */

import * as fs from 'fs';
import * as path from 'path';

const DIR = path.join(process.cwd(), 'accounts', 'tokens');

interface DecodedClaims { [k: string]: any }

function decode(token: string): DecodedClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

const all: { pubkey: string; access?: DecodedClaims; refresh?: DecodedClaims }[] = [];

for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue;
  const pubkey = f.replace(/\.json$/, '');
  const data = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8'));
  all.push({
    pubkey,
    access: data.accessToken ? decode(data.accessToken) || undefined : undefined,
    refresh: data.refreshToken ? decode(data.refreshToken) || undefined : undefined,
  });
}

for (const a of all) {
  console.log(`\n========== ${a.pubkey} ==========`);
  if (a.access) {
    console.log('-- access token claims --');
    console.log(JSON.stringify(a.access, null, 2));
  } else {
    console.log('(no access token)');
  }
  if (a.refresh) {
    console.log('-- refresh token claims --');
    console.log(JSON.stringify(a.refresh, null, 2));
  }
}

// Diff helper: union of all keys, mark which differ
const keys = new Set<string>();
for (const a of all) if (a.access) for (const k of Object.keys(a.access)) keys.add(k);

if (all.length > 1) {
  console.log('\n========== DIFF (access claims) ==========');
  for (const k of [...keys].sort()) {
    const values = all.map(a => a.access?.[k]);
    const allSame = values.every(v => JSON.stringify(v) === JSON.stringify(values[0]));
    const tag = allSame ? '   ' : ' * ';
    console.log(`${tag} ${k}:`);
    for (let i = 0; i < all.length; i++) {
      console.log(`      ${all[i].pubkey.slice(0, 8)}: ${JSON.stringify(values[i])}`);
    }
  }
}
