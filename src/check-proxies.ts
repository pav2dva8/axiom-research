/**
 * Check proxies and identify which ones get 404/rate limited
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import nodeFetch from 'node-fetch';

const proxies = [
  '31.59.20.176:6754:yrxidqvh:9511myle6vtx',
  '23.95.150.145:6114:yrxidqvh:9511myle6vtx',
  '198.23.239.134:6540:yrxidqvh:9511myle6vtx',
  '45.38.107.97:6014:yrxidqvh:9511myle6vtx',
  '107.172.163.27:6543:yrxidqvh:9511myle6vtx',
  '198.105.121.200:6462:yrxidqvh:9511myle6vtx',
  '64.137.96.74:6641:yrxidqvh:9511myle6vtx',
  '216.10.27.159:6837:yrxidqvh:9511myle6vtx',
  '23.26.71.145:5628:yrxidqvh:9511myle6vtx',
  '23.229.19.94:8689:yrxidqvh:9511myle6vtx',
];

interface ProxyResult {
  proxy: string;
  ip: string;
  country: string;
  axiomStatus: number | string;
  works: boolean;
}

async function checkProxy(proxyStr: string): Promise<ProxyResult> {
  const [host, port, username, password] = proxyStr.split(':');
  const proxyUrl = `http://${username}:${password}@${host}:${port}`;
  const agent = new HttpsProxyAgent(proxyUrl);

  let ip = 'unknown';
  let country = 'unknown';
  let axiomStatus: number | string = 'error';
  let works = false;

  // Get IP and country
  try {
    const ipRes = await nodeFetch('https://ipapi.co/json/', { agent, timeout: 10000 } as any);
    if (ipRes.ok) {
      const data = await ipRes.json() as any;
      ip = data.ip || 'unknown';
      country = data.country_name || data.country || 'unknown';
    }
  } catch (e: any) {
    console.log(`  IP check failed: ${e.message}`);
  }

  // Test Axiom API
  try {
    const axiomRes = await nodeFetch('https://api2.axiom.trade/wallet-nonce', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://axiom.trade',
        'Referer': 'https://axiom.trade/',
      },
      body: JSON.stringify({
        walletAddress: 'TestWallet' + Math.random().toString(36).slice(2),
        v: Date.now(),
      }),
      agent,
      timeout: 10000,
    } as any);

    axiomStatus = axiomRes.status;
    // 200 = works, 404 = blocked/wrong region, 500 = rate limited
    works = axiomRes.status === 200;
  } catch (e: any) {
    axiomStatus = e.message;
  }

  return { proxy: host, ip, country, axiomStatus, works };
}

async function main() {
  console.log('Checking proxies for Axiom API compatibility...\n');

  const results: ProxyResult[] = [];

  for (const proxy of proxies) {
    const host = proxy.split(':')[0];
    process.stdout.write(`Checking ${host}... `);
    const result = await checkProxy(proxy);
    results.push(result);
    console.log(`${result.country} - Axiom: ${result.axiomStatus} ${result.works ? '✓' : '✗'}`);
  }

  console.log('\n--- Summary ---\n');
  console.log('Working proxies:');
  results.filter(r => r.works).forEach(r => {
    console.log(`  ${r.proxy} (${r.country})`);
  });

  console.log('\nBlocked/404 proxies:');
  results.filter(r => r.axiomStatus === 404).forEach(r => {
    console.log(`  ${r.proxy} (${r.country})`);
  });

  console.log('\nRate limited (500) proxies:');
  results.filter(r => r.axiomStatus === 500).forEach(r => {
    console.log(`  ${r.proxy} (${r.country})`);
  });

  console.log('\nOther errors:');
  results.filter(r => !r.works && r.axiomStatus !== 404 && r.axiomStatus !== 500).forEach(r => {
    console.log(`  ${r.proxy} (${r.country}) - ${r.axiomStatus}`);
  });
}

main().catch(console.error);
