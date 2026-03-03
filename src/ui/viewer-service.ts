/**
 * Viewer Service
 *
 * Manages WebSocket connections to friends server for viewer count
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { LoadedAccount } from './account-manager';

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

export interface ViewerConnection {
  accountId: number;
  ws: WebSocket;
  connected: boolean;
}

export interface ViewerStrategy {
  type: 'immediate' | 'gradual';
  immediateCount?: number;      // For immediate: how many viewers to add at once
  gradualCount?: number;        // For gradual: viewers per interval
  gradualIntervalMs?: number;   // For gradual: interval in ms
}

export class ViewerService extends EventEmitter {
  private connections: Map<number, ViewerConnection> = new Map();
  private tokenInfo: TokenInfo | null = null;
  private gradualTimer: NodeJS.Timeout | null = null;
  private pendingAccounts: LoadedAccount[] = [];

  constructor() {
    super();
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

      const data = await response.json();

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

  private connectAccount(account: LoadedAccount): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.tokenInfo) {
        resolve(false);
        return;
      }

      const ws = new WebSocket('wss://friends.axiom.trade/ws', {
        headers: {
          'Origin': 'https://axiom.trade',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Cookie': account.cookies,
        }
      });

      const timeout = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 10000);

      ws.on('open', () => {
        clearTimeout(timeout);

        // Start ping
        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('.');
          } else {
            clearInterval(pingInterval);
          }
        }, 1000);

        // Send pageUpdate
        const pageUpdate = {
          type: 'pageUpdate',
          page: 'meme',
          subpage: this.tokenInfo,
          chain: 'sol'
        };
        ws.send(JSON.stringify(pageUpdate));

        this.connections.set(account.id, {
          accountId: account.id,
          ws,
          connected: true
        });

        this.emit('viewer-connected', account.id);
        resolve(true);
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        const conn = this.connections.get(account.id);
        if (conn) {
          conn.connected = false;
        }
        this.connections.delete(account.id);
        this.emit('viewer-disconnected', account.id);
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  async startImmediate(accounts: LoadedAccount[], count: number): Promise<number> {
    const toConnect = accounts.slice(0, count);
    let connected = 0;

    for (const account of toConnect) {
      const success = await this.connectAccount(account);
      if (success) {
        connected++;
        this.emit('progress', connected, count);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    return connected;
  }

  startGradual(accounts: LoadedAccount[], countPerInterval: number, intervalMs: number): void {
    this.pendingAccounts = [...accounts];

    const addViewers = async () => {
      const toAdd = this.pendingAccounts.splice(0, countPerInterval);

      if (toAdd.length === 0) {
        this.stopGradual();
        this.emit('gradual-complete');
        return;
      }

      for (const account of toAdd) {
        await this.connectAccount(account);
        await new Promise(r => setTimeout(r, 50));
      }

      this.emit('gradual-tick', this.getActiveCount(), this.pendingAccounts.length);
    };

    // Add first batch immediately
    addViewers();

    // Then continue at interval
    this.gradualTimer = setInterval(addViewers, intervalMs);
  }

  stopGradual(): void {
    if (this.gradualTimer) {
      clearInterval(this.gradualTimer);
      this.gradualTimer = null;
    }
    this.pendingAccounts = [];
  }

  disconnectAll(): void {
    this.stopGradual();

    for (const [, conn] of this.connections) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close();
      }
    }
    this.connections.clear();
  }

  getActiveCount(): number {
    let count = 0;
    for (const [, conn] of this.connections) {
      if (conn.connected && conn.ws.readyState === WebSocket.OPEN) {
        count++;
      }
    }
    return count;
  }

  getPendingCount(): number {
    return this.pendingAccounts.length;
  }

  isGradualRunning(): boolean {
    return this.gradualTimer !== null;
  }

  isAccountConnected(accountId: number): boolean {
    const conn = this.connections.get(accountId);
    return conn?.connected === true && conn.ws.readyState === WebSocket.OPEN;
  }
}

export const viewerService = new ViewerService();
