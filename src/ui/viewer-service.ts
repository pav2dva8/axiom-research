/**
 * Viewer Service
 *
 * Manages WebSocket connections to friends server for viewer count.
 * Uses browser-based WS connections (via BrowserSession) to bypass CF TLS fingerprint checks.
 * Each connection uses per-account auth cookies set before the WS handshake.
 */

import { EventEmitter } from 'events';
import type { LoadedAccount } from './account-manager';
import type { BrowserSession } from '../browser-auth';

export interface TokenInfo {
  pairAddress: string;
  tokenAddress: string;
  ticker: string;
  name: string;
  protocol: string;
  isMigrated: boolean;
  supply: number;
  price: number;
}

export interface ViewerStrategy {
  type: 'immediate' | 'gradual';
  immediateCount?: number;
  gradualCount?: number;
  gradualIntervalMs?: number;
}

export class ViewerService extends EventEmitter {
  private browserSession: BrowserSession | null = null;
  private connectedViewers: Map<number, number> = new Map(); // accountId -> browserId
  private tokenInfo: TokenInfo | null = null;

  constructor() {
    super();
  }

  setBrowserSession(session: BrowserSession | null): void {
    this.browserSession = session;
    console.log('[Viewer] Browser session', session ? 'set' : 'cleared');
  }

  async fetchTokenInfo(pairAddress: string): Promise<TokenInfo | null> {
    try {
      const response = await fetch(
        `https://api2.axiom.trade/pair-info?pairAddress=${pairAddress}&v=${Date.now()}`,
        {
          headers: {
            'Origin': 'https://axiom.trade',
            'Referer': 'https://axiom.trade/',
          }
        }
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;

      return {
        pairAddress,
        tokenAddress: data.tokenAddress || data.baseToken?.address || '',
        ticker: data.ticker || data.baseToken?.symbol || 'UNKNOWN',
        name: data.name || data.baseToken?.name || 'Unknown Token',
        protocol: data.protocol || 'Pump V1',
        isMigrated: data.isMigrated || false,
        supply: data.supply || data.baseToken?.totalSupply || 1000000000,
        price: data.price || data.priceUsd || 0
      };
    } catch {
      return null;
    }
  }

  setTokenInfo(tokenInfo: TokenInfo): void {
    this.tokenInfo = tokenInfo;
  }

  private async connectAccount(account: LoadedAccount): Promise<boolean> {
    if (!this.tokenInfo || !this.browserSession) {
      console.log(`[Viewer] Cannot connect account ${account.id}: no ${!this.tokenInfo ? 'token info' : 'browser session'}`);
      return false;
    }

    try {
      const viewerId = await this.browserSession.connectViewer(
        account.accessToken,
        account.refreshToken,
        this.tokenInfo,
      );
      this.connectedViewers.set(account.id, viewerId);
      console.log(`[Viewer] Account ${account.id} connected as viewer ${viewerId}`);
      this.emit('viewer-connected', account.id);
      return true;
    } catch (err: any) {
      console.log(`[Viewer] Account ${account.id} failed:`, err.message);
      return false;
    }
  }

  async connectAll(accounts: LoadedAccount[], delayMs: number = 100): Promise<number> {
    let connected = 0;
    for (const account of accounts) {
      if (this.connectedViewers.has(account.id)) continue;
      const success = await this.connectAccount(account);
      if (success) connected++;
      await new Promise(r => setTimeout(r, delayMs));
    }
    return connected;
  }

  disconnectAll(): void {
    if (this.browserSession) {
      this.browserSession.disconnectAllViewers().catch(() => {});
    }
    this.connectedViewers.clear();
  }

  getActiveCount(): number {
    return this.connectedViewers.size;
  }

  isAccountConnected(accountId: number): boolean {
    return this.connectedViewers.has(accountId);
  }
}

export const viewerService = new ViewerService();
