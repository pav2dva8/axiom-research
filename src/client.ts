import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  AxiomConfig,
  JoinRoomMessage,
  LeaveRoomMessage,
  PingMessage,
  RoomPrefixes,
  GlobalRooms,
} from './types';

const DEFAULT_CONFIG: Required<AxiomConfig> = {
  wsUrl: 'wss://cluster8.axiom.trade/',
  pingInterval: 25000, // 25 seconds
  reconnectDelay: 3000,
  maxReconnectAttempts: 10,
};

// Friends server uses different ping format ("." every second)
const FRIENDS_CONFIG: Required<AxiomConfig> = {
  wsUrl: 'wss://friends.axiom.trade/ws',
  pingInterval: 1000, // 1 second (like browser)
  reconnectDelay: 3000,
  maxReconnectAttempts: 10,
};

export class AxiomClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: Required<AxiomConfig>;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private subscribedRooms: Set<string> = new Set();
  private isConnecting = false;
  private cookies: string;
  private userId: string;

  constructor(config: AxiomConfig = {}, cookies: string = '', userId: string = '') {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cookies = cookies;
    this.userId = userId;
  }

  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      // Append user-id to URL if provided (needed for eucalyptus)
      let wsUrl = this.config.wsUrl;
      if (this.userId) {
        const separator = wsUrl.includes('?') ? '&' : '?';
        wsUrl = `${wsUrl}${separator}user-id=${this.userId}`;
      }
      console.log(`[AxiomClient] Connecting to ${wsUrl}...`);

      const headers: Record<string, string> = {
        'Origin': 'https://axiom.trade',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      };

      if (this.cookies) {
        headers['Cookie'] = this.cookies;
      }

      this.ws = new WebSocket(wsUrl, { headers });

      this.ws.on('open', () => {
        console.log('[AxiomClient] Connected!');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.startPing();
        this.resubscribeRooms();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[AxiomClient] Disconnected: ${code} - ${reason.toString()}`);
        this.isConnecting = false;
        this.stopPing();
        this.emit('disconnected', code, reason.toString());
        this.attemptReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('[AxiomClient] Error:', error.message);
        this.isConnecting = false;
        this.emit('error', error);
        if (this.reconnectAttempts === 0) {
          reject(error);
        }
      });
    });
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());

      // Handle pong responses
      if (message.method === 'pong') {
        this.emit('pong');
        return;
      }

      // Emit the raw message
      this.emit('message', message);

      // Try to identify the room/type from the message
      if (message.room) {
        this.emit(`room:${message.room}`, message);
      }

      // Emit typed events based on message content
      if (message.type) {
        this.emit(`type:${message.type}`, message);
      }

    } catch (error) {
      console.error('[AxiomClient] Failed to parse message:', data.toString().slice(0, 100));
    }
  }

  private send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const ping: PingMessage = { method: 'ping' };
      this.send(ping);
    }, this.config.pingInterval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('[AxiomClient] Max reconnect attempts reached');
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * this.reconnectAttempts;
    console.log(`[AxiomClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

    setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }

  private resubscribeRooms(): void {
    for (const room of this.subscribedRooms) {
      this.joinRoom(room, false);
    }
  }

  // Public API

  joinRoom(room: string, track = true): void {
    if (track) {
      this.subscribedRooms.add(room);
    }
    const message: JoinRoomMessage = { action: 'join', room };
    this.send(message);
    console.log(`[AxiomClient] Joined room: ${room}`);
  }

  leaveRoom(room: string): void {
    this.subscribedRooms.delete(room);
    const message: LeaveRoomMessage = { action: 'leave', room };
    this.send(message);
    console.log(`[AxiomClient] Left room: ${room}`);
  }

  // Convenience methods for subscribing to token-specific rooms

  subscribeToToken(tokenAddress: string): void {
    const rooms = [
      `${RoomPrefixes.TOKEN}${tokenAddress}`,
      `${RoomPrefixes.FEED}${tokenAddress}`,
      `${RoomPrefixes.TOKEN_DETAILS}${tokenAddress}`,
      `${RoomPrefixes.SUBSCRIBERS}${tokenAddress}`,
      `${RoomPrefixes.EVENTS}${tokenAddress}`,
    ];
    rooms.forEach(room => this.joinRoom(room));
  }

  unsubscribeFromToken(tokenAddress: string): void {
    const rooms = [
      `${RoomPrefixes.TOKEN}${tokenAddress}`,
      `${RoomPrefixes.FEED}${tokenAddress}`,
      `${RoomPrefixes.TOKEN_DETAILS}${tokenAddress}`,
      `${RoomPrefixes.SUBSCRIBERS}${tokenAddress}`,
      `${RoomPrefixes.EVENTS}${tokenAddress}`,
    ];
    rooms.forEach(room => this.leaveRoom(room));
  }

  subscribeToPrices(): void {
    this.joinRoom(GlobalRooms.SOL_PRICE);
    this.joinRoom(GlobalRooms.BTC_PRICE);
    this.joinRoom(GlobalRooms.ETH_PRICE);
    this.joinRoom(GlobalRooms.BNB_PRICE);
  }

  subscribeToMigrations(): void {
    this.joinRoom(GlobalRooms.MIGRATIONS);
    this.joinRoom(GlobalRooms.MIGRATION_HEAVEN);
  }

  subscribeToFees(): void {
    this.joinRoom(GlobalRooms.JITO_BRIBE_FEE);
    this.joinRoom(GlobalRooms.SOL_PRIORITY_FEE);
  }

  subscribeToGlobal(): void {
    this.subscribeToPrices();
    this.subscribeToMigrations();
    this.subscribeToFees();
    this.joinRoom(GlobalRooms.BLOCK_HASH);
    this.joinRoom(GlobalRooms.ANNOUNCEMENT);
  }

  // Subscribe to viewer count (eyes) for a token
  // NOTE: This requires connecting to wss://eucalyptus.axiom.trade/ws
  subscribeToViewerCount(tokenAddress: string): void {
    const room = `${RoomPrefixes.EYES}${tokenAddress}`;
    this.joinRoom(room);
  }

  unsubscribeFromViewerCount(tokenAddress: string): void {
    const room = `${RoomPrefixes.EYES}${tokenAddress}`;
    this.leaveRoom(room);
  }

  disconnect(): void {
    this.stopPing();
    this.reconnectAttempts = this.config.maxReconnectAttempts; // Prevent reconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get rooms(): string[] {
    return Array.from(this.subscribedRooms);
  }

  // Send raw string (for friends server ping ".")
  sendRaw(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }
}

/**
 * FriendsClient - specialized client for friends.axiom.trade
 * Uses "." as ping instead of {"method":"ping"}
 */
export class FriendsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: Required<AxiomConfig>;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private cookies: string;

  constructor(cookies: string = '') {
    super();
    this.config = { ...FRIENDS_CONFIG };
    this.cookies = cookies;
  }

  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      console.log(`[FriendsClient] Connecting to ${this.config.wsUrl}...`);

      const headers: Record<string, string> = {
        'Origin': 'https://axiom.trade',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      };

      if (this.cookies) {
        headers['Cookie'] = this.cookies;
      }

      this.ws = new WebSocket(this.config.wsUrl, { headers });

      this.ws.on('open', () => {
        console.log('[FriendsClient] Connected!');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.startPing();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        const msg = data.toString();
        // Friends server sends simple responses
        this.emit('message', msg);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[FriendsClient] Disconnected: ${code} - ${reason.toString()}`);
        this.isConnecting = false;
        this.stopPing();
        this.emit('disconnected', code, reason.toString());
        this.attemptReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('[FriendsClient] Error:', error.message);
        this.isConnecting = false;
        this.emit('error', error);
        if (this.reconnectAttempts === 0) {
          reject(error);
        }
      });
    });
  }

  private startPing(): void {
    this.stopPing();
    // Friends server uses "." as ping every second
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('.');
      }
    }, this.config.pingInterval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('[FriendsClient] Max reconnect attempts reached');
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * this.reconnectAttempts;
    console.log(`[FriendsClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

    setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }

  disconnect(): void {
    this.stopPing();
    this.reconnectAttempts = this.config.maxReconnectAttempts;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
