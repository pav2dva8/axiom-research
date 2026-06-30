# On-chain deploy watch + delayed viewer start — Design

Date: 2026-06-30

## Context

The viewer tool already accepts a token CA or an axiom.trade link in the Run tab.
For a bare pump.fun CA, `/api/resolve` derives the pre-migration pair locally via
`derivePumpPair`, and `/api/viewers/start` immediately connects selected accounts
to the target rooms, including `e-<pair>`.

The operator knows the token CA before launch and wants viewers to start as soon
as the token deploys. Prestarting the current viewer flow is not acceptable
because it joins the token viewer room before deploy, so the token can already
show viewers at launch.

## Goal

Add a "watch deploy and start" flow that prepares everything that does not count
as viewing, waits for the CA mint account to exist on Solana, then starts the
existing viewer connection flow immediately after the on-chain trigger fires.

## Non-goals

- Starting viewers before the mint account exists.
- Watching axiom.trade page availability as the primary deploy signal.
- Proxy support or multi-RPC routing.
- Supporting arbitrary non-pump bare pair inputs in watch mode. Watch mode is
  for a bare token CA; axiom.trade links continue to use the normal Start path.

## Architecture

Add a small deploy watcher service behind the existing UI server. The watcher
accepts a bare CA, validates it as a Solana public key, derives the pump pair
when possible, prepares the browser session, validates selected accounts, then
waits for the CA account to exist on-chain.

When the mint account exists, the watcher sets `viewerService` token info and
calls the same `viewerService.connectAll(accounts, opts)` path used by
`/api/viewers/start`. This preserves existing account ordering, concurrency,
bootstrap toggle, progress events, stop behavior, and viewer lifecycle.

Preparation must not call `connectViewer`, open target cluster9 rooms, send the
friends `pageUpdate` for the target token, or join `e-<pair>`. Those actions
remain inside the final start step after deploy detection.

## Configuration

Add `.env.example`:

```env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WS_URL=
DEPLOY_WATCH_POLL_MS=250
```

Runtime behavior:

- `SOLANA_RPC_URL` is the HTTP RPC endpoint used for initial account checks and
  polling fallback.
- `SOLANA_WS_URL` is optional. When present, use it for account-change
  subscription so detection can be faster and quieter.
- `DEPLOY_WATCH_POLL_MS` controls polling fallback cadence.

The app should load these from `process.env`, with the public mainnet RPC and
250 ms polling as defaults.

## Backend API

Add `POST /api/viewers/watch-deploy-start` with body:

```json
{
  "input": "8jLBHhGC4SSmcapWfjztdTLjt6gtfKe1GYcDdor1pump",
  "minGapMs": 20,
  "maxGapMs": 50,
  "bootstrapDisabled": true,
  "concurrency": 1
}
```

Validation:

- `input` must be a bare base58 address, not an axiom.trade link.
- The CA must be a valid Solana public key.
- For pump CAs, derive the pair locally with `derivePumpPair`.
- If no pair can be derived, fail early with a clear error; this keeps watch
  mode scoped to the pre-known pump CA launch use case.
- Selected accounts must exist before watching begins.

Response:

- Keep the HTTP request open until the watcher either starts viewers, is
  canceled, or fails. Return `{ connected, total, detectedAt, slot? }` on
  success.
- Return a cancellation response if Stop is clicked before deploy.

## Watcher Behavior

Deploy detection sequence:

1. Check `getAccountInfo(CA)` over HTTP RPC. If the account already exists,
   start viewers immediately.
2. If `SOLANA_WS_URL` is configured, subscribe to the CA account. On account
   change, perform one HTTP confirmation read, then start viewers.
3. If WebSocket setup fails or no WS URL is configured, poll `getAccountInfo(CA)`
   every `DEPLOY_WATCH_POLL_MS`.
4. On detection, remove subscriptions, stop polling timers, and call the existing
   viewer start path exactly once.

Cancellation:

- `POST /api/viewers/stop` cancels any active deploy watch before or alongside
  stopping viewers.
- Canceling while only watching must not mark accounts as connected or leave
  Solana subscriptions open.
- Canceling after detection should reuse the existing `viewerService.disconnectAll`
  behavior, including halting any in-progress connect loop.

Concurrency:

- Only one deploy watch can be active at a time. Starting another watch while
  one is active returns a conflict error.
- Normal Start remains disabled while a deploy watch is active.

## UI Flow

In `RunTab`, add a `Watch deploy` button next to `Start`.

Button behavior:

- Enabled only when the input is a bare CA and no viewer run/watch is active.
- Sends the same delay, concurrency, and bootstrap options as normal Start.
- Sets the run state to active while waiting.

Logs:

- `Prepared browser/accounts for CA ...`
- `Watching mint account ...`
- `Mint detected, starting viewers...`
- `Started N viewer(s) on TOKEN`
- Errors such as invalid CA, unsupported non-pump CA, RPC failure, or canceled.

The token info panel can show the derived pair immediately and keep `ticker` as
`TOKEN` until Axiom metadata is available.

## WebSocket Progress

Add a `deploy-watch` UI WebSocket event for watcher state:

```json
{
  "state": "preparing|watching|detected|starting|canceled|failed",
  "message": "Watching mint account ...",
  "ca": "...",
  "pairAddress": "..."
}
```

Existing `viewer-run` and `viewer-progress` events continue to represent actual
viewer connections only. Pending/connecting viewer pills should begin when the
watcher transitions to `starting`, not while it is merely watching the mint.

## Files Touched

| File | Change |
|---|---|
| `.env.example` | Document Solana RPC, optional WS URL, and poll cadence |
| `src/ui/deploy-watcher.ts` | New on-chain account watcher with WS plus polling fallback |
| `src/ui/server.ts` | New watch/start endpoint, deploy-watch broadcasts, stop cancellation |
| `src/ui/web/src/components/RunTab.tsx` | Watch deploy button and active watch state |
| `src/ui/web/src/App.tsx` | Handle `deploy-watch` WS events and log messages |

## Testing / Verification

Automated checks:

- `npm run build`
- `npm run build:web`

Manual checks:

1. Use a known already-deployed pump CA. `Watch deploy` should detect immediately
   and start viewers through the existing progress flow.
2. Use a valid unused public key. `Watch deploy` should enter watching state and
   Stop should cancel cleanly without connecting viewers.
3. Leave `SOLANA_WS_URL` empty and confirm polling fallback works.
4. Configure a bad `SOLANA_WS_URL` and confirm it logs the WS failure and falls
   back to polling.
5. Confirm normal Start still works for both axiom.trade links and bare CAs.

## Risks

- Public RPC endpoints may throttle fast polling. The default is conservative
  enough for a fallback, but a paid RPC with WebSocket support is recommended
  for launch timing.
- Detection based on account existence is earlier than Axiom page availability.
  The existing viewer start flow can still run before Axiom metadata has filled
  in, so the watcher uses derived pair and minimal token info.
- If the browser session preparation hits Cloudflare or account-token problems,
  the watch should fail before waiting for deploy so the operator can fix it
  before launch.
