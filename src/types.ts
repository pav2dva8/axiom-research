// Axiom WebSocket message types

export interface JoinRoomMessage {
  action: 'join';
  room: string;
}

export interface LeaveRoomMessage {
  action: 'leave';
  room: string;
}

export interface PingMessage {
  method: 'ping';
}

export interface PongMessage {
  method: 'pong';
}

export type OutgoingMessage = JoinRoomMessage | LeaveRoomMessage | PingMessage;

// Room prefixes based on observed traffic
export const RoomPrefixes = {
  TOKEN: 't:',           // Token data
  FEED: 'f:',            // Token feed/trades
  TOKEN_DETAILS: 'td:',  // Token details
  SUBSCRIBERS: 's:',     // Viewer count
  EVENTS: 'e:',          // Token events
  KOL_TX: 'kol_tx:',     // KOL transactions
  PUMP_CTO: 'pump-cto:', // Pump.fun CTO
  USER_TX: 'user-tx:',   // User transactions
  SOC_BUB: 'soc_bub:',   // Social bubble map
} as const;

// Global rooms
export const GlobalRooms = {
  SOL_PRICE: 'sol_price',
  BTC_PRICE: 'btc_price',
  ETH_PRICE: 'eth_price',
  BNB_PRICE: 'bnb_price',
  MIGRATIONS: 'migrations',
  MIGRATION_HEAVEN: 'migration-heaven',
  BNB_MIGRATIONS: 'bnb|migrations',
  JITO_BRIBE_FEE: 'jito-bribe-fee',
  SOL_PRIORITY_FEE: 'sol-priority-fee',
  BLOCK_HASH: 'block_hash',
  LIGHTHOUSE: 'lighthouse',
  ANNOUNCEMENT: 'announcement',
  CONNECTION_MONITOR: 'connection_monitor',
  FORCE_REFRESH: 'force-refresh',
  BNB_GAS_STANDARD: 'bnb|gas_standard',
  BNB_GAS_FAST: 'bnb|gas_fast',
  BNB_GAS_RAPID: 'bnb|gas_rapid',
} as const;

export interface AxiomConfig {
  wsUrl?: string;
  pingInterval?: number;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
}

export type MessageHandler = (data: unknown, room?: string) => void;
