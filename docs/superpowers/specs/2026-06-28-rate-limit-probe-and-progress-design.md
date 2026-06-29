# Rate-limit measurement + live progress + expiry countdown — Design

Date: 2026-06-28
Branch: `feat/rate-limit-probe-and-progress`

## Context

The axiom-viewer tool logs N Solana accounts into axiom.trade and connects them as
"viewers" on a token page. Two operator-facing goals motivated this work:

1. **Keep ~100 accounts logged in.** Access tokens live only **~16 minutes**
   (`exp - iat`, decoded from cached JWTs); refresh tokens are long-lived (no `exp`)
   and refresh is cheap (no Turnstile/signing — `refreshAccount`). The blocker is an
   unknown **per-IP rate limit** on `/refresh-access-token`; the operator has observed
   "~15 from one IP" but not the window/cooldown. Everything runs through a single
   Chrome instance = single IP (no proxy is wired into the live tool).
2. **Connect viewers faster.** Already solved by the existing `concurrency` worker
   pool (`viewer-service.connectAll` + `browser-auth.ensurePageSlots`), exposed in the
   UI as "Concurrent handshakes". Out of scope here — operator will set the dial.

This spec covers three deliverables chosen by the operator:
**(A) measure the refresh rate limit, (B) show token-expiry countdown,
(C) show live per-account viewer-connect progress.** Auto-refresh scheduling is
explicitly deferred until (A) yields real numbers.

## Goals

- Learn the true per-IP refresh ceiling and cooldown — passively (always-on) and via
  an on-demand probe.
- Make each account's remaining token life visible at a glance.
- Replace the blind spinner during viewer launch with a live per-account status list.

## Non-goals

- Auto-refresh scheduler / background keep-warm loop (deferred — decide after measuring).
- Proxy / multi-IP support (the cf_clearance cookie is IP-bound; a real multi-IP
  design needs one browser context per proxy — separate, larger effort).
- Changing the default viewer concurrency.

## Deliverable A — Rate-limit measurement

### A1. Passive capture (always on)

`browser-auth.ts` `refreshAccount` currently runs a `fetch` inside `friendsPage.evaluate`
and returns only `{ ok, status, body }`. Extend the in-page fetch to also return the
**response headers** of interest and the elapsed time:

```
{ ok, status, body, elapsedMs, headers: { 'retry-after', 'ratelimit-remaining',
  'ratelimit-limit', 'ratelimit-reset', 'x-ratelimit-remaining', 'x-ratelimit-limit',
  'x-ratelimit-reset' } }   // only those present; lower-cased keys
```

`refreshAccount` (browser-auth) returns the tokens on success as today, but on failure
throws an error whose message includes status + any `retry-after`. `account-manager`'s
refresh path logs a structured rate-limit line whenever status is `429` or a rate-limit
header is present, surfaced to the UI LogPanel (red on 429). No behavior change on the
happy path.

### A2. Probe button ("Find refresh limit")

New endpoint `POST /api/accounts/probe-limit` with body `{ publicKeys?: string[], cap?: number }`.

- Target pool: provided `publicKeys`, else current selection, else all — **capped at
  `cap` (default 20)**.
- Fires `refreshAccount` **back-to-back with no inter-request gap** on the single IP,
  counting consecutive successes until the **first** `429`/throttle/error, or until the
  cap is exhausted.
- Streams progress over WS (`probe-progress`) and returns a summary:
  ```
  { successesBeforeThrottle, attempted, elapsedMs, requestsPerMin,
    throttled: boolean, retryAfterSec: number|null, firstErrorStatus, firstErrorBody }
  ```
- Refresh is **non-destructive** (rotated tokens are written back; accounts stay valid),
  so the only cost is deliberately tripping the limit once. Reuses the open browser
  session (opens one if needed, like the existing refresh flow).

UI: a "Find refresh limit" button in AccountsTab next to Refresh/Re-login. On click it
calls the endpoint and renders the summary into the LogPanel (and a small result line).

## Deliverable B — Expiry countdown (Accounts tab)

- Backend: `AccountRecord` (account-manager.ts) gains `accessExpiresAt?: number`
  (epoch-ms of the access-token JWT `exp`). `listAccounts` decodes it (reuse the decode
  logic already in `isTokenValid`; factor a small `readAccessExp(pk)` helper).
- Frontend: AccountsTab table gains an **"Expires"** column. A single client-side
  `setInterval(1s)` re-renders a `mm:ss` countdown computed from `accessExpiresAt - now`.
  Color thresholds: **green > 5 min · amber ≤ 5 min · red expired/missing**. The 4s
  account poll refreshes the underlying `accessExpiresAt`; the countdown ticks locally
  between polls so it stays smooth and doesn't add server load.

## Deliverable C — Live connect progress (Run tab)

- Backend: `viewer-service.ts` already emits `viewer-connected`. Add:
  - `viewer-connecting` (emitted in `connectAccount` right before the handshake),
  - `viewer-failed` (emitted on catch),
  both carrying `publicKey`. `connectAll` still returns the final count and the HTTP
  response is unchanged.
- `server.ts` listens to all three and broadcasts a `viewer-progress` WS message:
  `{ publicKey, state: 'connecting'|'connected'|'failed', connected, total }`
  (`connected` = `viewerService.getActiveCount()`, `total` = accounts in the run).
- Frontend: RunTab keeps a `Map<publicKey, state>` rebuilt per Start (cleared on Start
  and on Stop). Renders a compact per-account list (shortened pubkey + state pill:
  connecting/connected/failed) and a header "**N/total connected**". Driven entirely by
  the `viewer-progress` WS stream; the existing `/api/viewers/start` call still returns
  the final count as a backstop.

## WS message types (App.tsx)

Add handlers for:
- `viewer-progress` → update RunTab's per-account map + header.
- `probe-progress` → append probe step lines to the log.
(`status`, `relogin-progress`, `accounts-changed` already handled.) App.tsx passes the
new viewer-progress state down to RunTab (lifted state or a shared store/context — keep
it simple: lift the per-account progress map into App and pass to RunTab, since App owns
the WS).

## Files touched

| File | Change |
|---|---|
| `src/browser-auth.ts` | `refreshAccount`: capture headers + elapsedMs; richer error on throttle |
| `src/ui/account-manager.ts` | `accessExpiresAt` in `listAccounts`; `readAccessExp` helper; `probeLimit()` method; log rate-limit signals |
| `src/ui/viewer-service.ts` | emit `viewer-connecting` / `viewer-failed` |
| `src/ui/server.ts` | `POST /api/accounts/probe-limit`; broadcast `viewer-progress` + `probe-progress` |
| `src/ui/web/src/components/AccountsTab.tsx` | Expires countdown column; "Find refresh limit" button |
| `src/ui/web/src/components/RunTab.tsx` | live per-account progress list |
| `src/ui/web/src/App.tsx` | handle `viewer-progress` + `probe-progress`; own/pass progress state |

## Testing / verification

No automated test suite exists for this tool; verification is manual against the live
app (the operator runs it). After implementation:

1. `npm run build:web` then restart `npm run viewer-ui` (port 3847) — required, no HMR.
2. Hard-refresh the browser (Cmd+Shift+R) to drop the cached JS bundle.
3. Accounts tab: confirm Expires column counts down per account and colors flip at 5min/expiry.
4. Click "Find refresh limit" on a small selection; confirm it reports a ceiling +
   cooldown and logs each step.
5. Run tab: Start viewers; confirm per-account pills move connecting → connected/failed
   live and the N/total header tracks `activeViewers`.

## Addendum — measured limits + "Keep logged in" button (2026-06-28)

Probe results: **refresh ceiling ≈ 16 per IP, cooldown ≈ 31s, ~150/min before the wall.**
The throttle is NOT a clean 429 — the in-page fetch fails with status 0 (CORS-less
response / reset connection); CDP capture (`Network.responseReceived` / `loadingFailed`
on the existing per-page session) surfaces the real wire status/reason. The probe now
treats 2 consecutive failures as the wall, confirms it's the IP (retries a known-good
account), then measures cooldown by polling until recovery.

**Capacity verdict:** one IP sustains ~16/31s ≈ 31 refreshes/min; keeping 100 accounts
alive needs only ~8/min. No proxies required.

**Keep logged in (refresh-only):** one button on the Accounts tab.
`accountManager.startKeepLoggedIn(targets, {delayMs=2500, thresholdMin=5}, onProgress)`
runs a background loop: first pass refreshes every selected account that has a refresh
token; later passes only refresh accounts within `thresholdMin` of expiry. Paced
`delayMs` apart (≈12–14 per 31s, under the wall). On the wall (2 consecutive fails) it
backs off 35s; an account whose refresh keeps failing (3×) is flagged dead and skipped
(needs a manual re-login — the per-row button still works during keep-warm). **It never
re-logins** — login has its own stricter limits, per operator. A `runExclusive` mutex in
account-manager serializes every browser refresh/login op (shared cookie jar is not
concurrency-safe) so the loop can't collide with a manual refresh/relogin/probe.
Endpoints: `POST /api/accounts/keepwarm/start|stop`; state in `statusPayload().keepWarm`
+ a `keepwarm` WS message. Stop via the button or `stopReloginAll`.

## Risks / notes

- The probe deliberately trips the rate limit; keep the default cap (20) modest so it
  doesn't lock the IP for long. Document the `retry-after` it reports.
- Single-IP ceiling may prove too low for 100 perpetually-warm accounts — that finding
  feeds the deferred auto-refresh decision (JIT vs background vs proxy-per-context).
- Concurrent refresh is **not** cookie-jar-safe (no lock in `refreshAccount`); the probe
  and all refresh loops stay **serial**, which is also what the rate-limit measurement
  needs (one request at a time = clean per-request timing).
