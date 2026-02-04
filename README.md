# Axiom WebSocket Bot

A TypeScript bot for connecting to Axiom.trade WebSocket API to receive real-time trading data.

## Features

- **Programmatic authentication** - Login with a Solana wallet (no browser needed)
- Connect to Axiom WebSocket clusters
- Subscribe to token-specific rooms (trades, prices, viewer counts)
- Subscribe to global rooms (SOL/BTC/ETH prices, migrations, fees)
- Auto-reconnect with exponential backoff
- Ping/pong keepalive

## Installation

```bash
npm install
```

## Quick Start

### Option 1: Programmatic Login (Recommended)

Generate a new wallet and authenticate with Axiom:

```bash
npm run login
```

This will:
1. Generate a new Solana wallet (saved to `wallet.json`)
2. Sign a message to prove ownership
3. Get auth tokens from Axiom
4. Save cookies to `.env` file

Then run the bot:
```bash
npm run dev
```

### Option 2: Use Existing Wallet

If you have a Solana private key (base58 encoded):

```bash
SOLANA_PRIVATE_KEY=your_private_key npm run login
```

### Option 3: Manual Cookie Setup

1. Login to https://axiom.trade in your browser
2. Open DevTools (F12) → Application → Cookies
3. Copy all cookies to `.env` file:
   ```
   AXIOM_COOKIES=cookie1=value1; cookie2=value2; ...
   ```

## Usage

### Development mode (with hot reload)

```bash
npm run dev
```

### Production build

```bash
npm run build
npm start
```

## Room Types

Based on reverse-engineering the Axiom WebSocket protocol:

| Prefix | Purpose | Example |
|--------|---------|---------|
| `t:` | Token data | `t:6csTBsNJD...` |
| `f:` | Token feed/trades | `f:6csTBsNJD...` |
| `td:` | Token details | `td:6csTBsNJD...` |
| `s:` | Subscribers/Viewers | `s:6csTBsNJD...` |
| `e:` | Events | `e:6csTBsNJD...` |
| `kol_tx:` | KOL transactions | `kol_tx:6csTBsNJD...` |

### Global Rooms

- `sol_price`, `btc_price`, `eth_price`, `bnb_price` - Price feeds
- `migrations`, `migration-heaven` - Token migrations
- `jito-bribe-fee`, `sol-priority-fee` - Fee tracking
- `block_hash` - Latest block

## API

```typescript
import { AxiomClient } from './client';

const client = new AxiomClient({
  wsUrl: 'wss://cluster9.axiom.trade/',
});

await client.connect();

// Subscribe to a token
client.subscribeToToken('6csTBsNJD6q1Y8NnW5GgAXEs64vs37mvtargSmHcxySG');

// Subscribe to prices
client.subscribeToPrices();

// Listen for messages
client.on('message', (msg) => {
  console.log(msg);
});
```

## WebSocket Clusters

Axiom uses multiple WebSocket clusters for load balancing:
- `wss://cluster1.axiom.trade/`
- `wss://cluster9.axiom.trade/`
- (and possibly more)
