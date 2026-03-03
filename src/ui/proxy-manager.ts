/**
 * Proxy Manager
 *
 * Handles proxy storage, validation, and rotation
 */

import * as fs from 'fs';
import * as path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import nodeFetch from 'node-fetch';

export interface ProxyInfo {
  raw: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  status: 'unknown' | 'good' | 'bad';
  lastChecked?: string;
  rateLimitedUntil?: number; // timestamp when rate limit expires
}

const PROXIES_FILE = path.join(process.cwd(), 'proxies.json');
const MIN_DELAY_BETWEEN_USES_MS = 10000; // 10 seconds between uses of same proxy

export class ProxyManager {
  private proxies: ProxyInfo[] = [];
  private currentIndex = 0;
  private lastUsedTime: Map<string, number> = new Map(); // Track last use time per proxy

  constructor() {
    this.load();
  }

  private load(): void {
    if (fs.existsSync(PROXIES_FILE)) {
      try {
        this.proxies = JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf-8'));
      } catch {
        this.proxies = [];
      }
    }
  }

  private save(): void {
    fs.writeFileSync(PROXIES_FILE, JSON.stringify(this.proxies, null, 2));
  }

  parseProxy(raw: string): ProxyInfo | null {
    raw = raw.trim();
    if (!raw) return null;

    // Format 1: host:port:user:pass (your format)
    const fourPartMatch = raw.match(/^([^:]+):(\d+):([^:]+):(.+)$/);
    if (fourPartMatch) {
      return {
        raw,
        host: fourPartMatch[1],
        port: parseInt(fourPartMatch[2]),
        username: fourPartMatch[3],
        password: fourPartMatch[4],
        status: 'unknown'
      };
    }

    // Format 2: user:pass@host:port
    const atMatch = raw.match(/^(.+):(.+)@(.+):(\d+)$/);
    if (atMatch) {
      return {
        raw,
        username: atMatch[1],
        password: atMatch[2],
        host: atMatch[3],
        port: parseInt(atMatch[4]),
        status: 'unknown'
      };
    }

    // Format 3: host:port (no auth)
    const simpleMatch = raw.match(/^([^:]+):(\d+)$/);
    if (simpleMatch) {
      return {
        raw,
        host: simpleMatch[1],
        port: parseInt(simpleMatch[2]),
        status: 'unknown'
      };
    }

    return null;
  }

  setProxies(rawList: string): number {
    const lines = rawList.split('\n').filter(l => l.trim());
    this.proxies = [];

    for (const line of lines) {
      const proxy = this.parseProxy(line);
      if (proxy) {
        // Check if we already have this proxy with status
        const existing = this.proxies.find(p => p.raw === proxy.raw);
        if (!existing) {
          this.proxies.push(proxy);
        }
      }
    }

    this.save();
    return this.proxies.length;
  }

  getProxiesRaw(): string {
    return this.proxies.map(p => p.raw).join('\n');
  }

  getStats(): { total: number; good: number; bad: number } {
    return {
      total: this.proxies.length,
      good: this.proxies.filter(p => p.status === 'good').length,
      bad: this.proxies.filter(p => p.status === 'bad').length
    };
  }

  getProxyUrl(proxy: ProxyInfo): string {
    if (proxy.username && proxy.password) {
      return `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
    }
    return `http://${proxy.host}:${proxy.port}`;
  }

  getAgent(proxy: ProxyInfo): HttpsProxyAgent<string> {
    return new HttpsProxyAgent(this.getProxyUrl(proxy));
  }

  async checkProxy(proxy: ProxyInfo): Promise<boolean> {
    try {
      const agent = this.getAgent(proxy);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await nodeFetch('https://api.ipify.org?format=json', {
        agent,
        signal: controller.signal as any
      });

      clearTimeout(timeout);
      proxy.status = response.ok ? 'good' : 'bad';
      proxy.lastChecked = new Date().toISOString();
      this.save();
      return proxy.status === 'good';
    } catch {
      proxy.status = 'bad';
      proxy.lastChecked = new Date().toISOString();
      this.save();
      return false;
    }
  }

  async checkAllProxies(onResult?: (proxy: string, ok: boolean) => void): Promise<{ good: number; bad: number }> {
    let good = 0;
    let bad = 0;

    for (const proxy of this.proxies) {
      const ok = await this.checkProxy(proxy);
      if (ok) good++;
      else bad++;
      onResult?.(proxy.raw, ok);
    }

    return { good, bad };
  }

  getNextGoodProxy(): ProxyInfo | null {
    const goodProxies = this.proxies.filter(p => p.status === 'good');
    if (goodProxies.length === 0) return null;

    const proxy = goodProxies[this.currentIndex % goodProxies.length];
    this.currentIndex++;

    // Track when this proxy was used
    this.lastUsedTime.set(proxy.raw, Date.now());

    return proxy;
  }

  /**
   * Get a proxy that hasn't been used recently (respects delay)
   * Returns the proxy and the wait time needed (0 if ready now)
   */
  getNextGoodProxyWithDelay(): { proxy: ProxyInfo | null; waitMs: number } {
    // Filter out rate-limited proxies
    const availableProxies = this.getAvailableProxies();
    if (availableProxies.length === 0) {
      // Check if any will become available soon
      const goodProxies = this.proxies.filter(p => p.status === 'good');
      if (goodProxies.length > 0) {
        const soonestAvailable = Math.min(...goodProxies.map(p => p.rateLimitedUntil || 0));
        const waitMs = Math.max(0, soonestAvailable - Date.now());
        if (waitMs > 0 && waitMs < 120000) { // Wait up to 2 minutes
          return { proxy: goodProxies[0], waitMs };
        }
      }
      return { proxy: null, waitMs: 0 };
    }

    const now = Date.now();

    // Find proxy with longest time since last use
    let bestProxy: ProxyInfo | null = null;
    let bestWaitMs = Infinity;

    for (const proxy of availableProxies) {
      const lastUsed = this.lastUsedTime.get(proxy.raw) || 0;
      const elapsed = now - lastUsed;
      const waitNeeded = Math.max(0, MIN_DELAY_BETWEEN_USES_MS - elapsed);

      if (waitNeeded < bestWaitMs) {
        bestWaitMs = waitNeeded;
        bestProxy = proxy;
      }
    }

    if (bestProxy) {
      this.lastUsedTime.set(bestProxy.raw, now + bestWaitMs);
    }

    return { proxy: bestProxy, waitMs: bestWaitMs };
  }

  getRandomGoodProxy(): ProxyInfo | null {
    const goodProxies = this.proxies.filter(p => p.status === 'good');
    if (goodProxies.length === 0) return null;
    return goodProxies[Math.floor(Math.random() * goodProxies.length)];
  }

  hasGoodProxies(): boolean {
    return this.proxies.some(p => p.status === 'good');
  }

  /**
   * Mark a proxy as rate limited (will be skipped for a while)
   */
  markRateLimited(proxy: ProxyInfo, durationMs: number = 60000): void {
    proxy.rateLimitedUntil = Date.now() + durationMs;
    console.log(`[ProxyManager] Marked ${proxy.host} as rate limited for ${durationMs / 1000}s`);
    this.save();
  }

  /**
   * Check if proxy is currently rate limited
   */
  isRateLimited(proxy: ProxyInfo): boolean {
    if (!proxy.rateLimitedUntil) return false;
    return Date.now() < proxy.rateLimitedUntil;
  }

  /**
   * Get available proxies (good and not rate limited)
   */
  getAvailableProxies(): ProxyInfo[] {
    return this.proxies.filter(p =>
      p.status === 'good' && !this.isRateLimited(p)
    );
  }

  /**
   * Get count of available proxies
   */
  getAvailableCount(): number {
    return this.getAvailableProxies().length;
  }

  /**
   * Get current proxy (keeps returning same until marked as bad)
   */
  private currentProxyIndex = 0;

  getNextAvailableProxy(): ProxyInfo | null {
    const goodProxies = this.proxies.filter(p => p.status === 'good');
    if (goodProxies.length === 0) return null;

    // Return current proxy if still valid
    if (this.currentProxyIndex < goodProxies.length) {
      return goodProxies[this.currentProxyIndex];
    }

    return null; // All proxies exhausted
  }

  /**
   * Mark current proxy as bad and move to next
   */
  markProxyUsed(proxy: ProxyInfo): void {
    const goodProxies = this.proxies.filter(p => p.status === 'good');
    const proxyIndex = goodProxies.findIndex(p => p.raw === proxy.raw);

    if (proxyIndex >= 0 && proxyIndex === this.currentProxyIndex) {
      this.currentProxyIndex++;
      const remaining = goodProxies.length - this.currentProxyIndex;
      console.log(`[ProxyManager] Proxy ${proxy.host} failed, moving to next (${remaining} remaining)`);
    }
  }

  /**
   * Get count of remaining proxies
   */
  getUnusedCount(): number {
    const goodProxies = this.proxies.filter(p => p.status === 'good');
    return Math.max(0, goodProxies.length - this.currentProxyIndex);
  }

  /**
   * Reset to start from first proxy
   */
  resetUsedProxies(): void {
    this.currentProxyIndex = 0;
    console.log('[ProxyManager] Reset proxy index to start');
  }
}

export const proxyManager = new ProxyManager();
