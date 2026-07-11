# Fresh account register tab — Design

Date: 2026-07-11

## Context

Axiom account signup already exists as `signup()` in `src/auth.ts`: the same
wallet verify flow as login with `allowRegistration: true`. CLI entry points
(`npm run signup`, older scripts) can create one account at a time.

The web UI only supports relogin / keep-warm for keys already listed in
`keys.txt`. Operators need a dedicated way to mint batches of fresh accounts
while respecting Axiom’s ~3 signups per IP rate limit, optionally rotating
through `proxies.txt`.

## Goal

Add a **Register** tab that generates new Solana wallets, signs them up on
Axiom, writes secrets to a dated fresh-keys file, and caches auth tokens under
`accounts/tokens/`, without modifying `keys.txt` or account selection.

## Non-goals

- Appending to or replacing `keys.txt` automatically.
- Showing fresh accounts in the Accounts table until the operator merges keys.
- Parallel signup across proxies (proxies run strictly one after another).
- Solving Turnstile / Cloudflare challenges beyond whatever `signup()` already
  supports today (optional `turnstileToken` / `cfCookies` params remain unused
  unless already wired elsewhere).
- Changing viewer, deploy-watch, or keep-warm behavior.

## Requirements (confirmed)

| Control | Behavior |
|---------|----------|
| Amount per IP | Integer, default `3`, clamped `1–3`. No global total. |
| Delay | Fixed seconds between signups on the same IP (default `5`). |
| Use proxies | If on: one IP slot per line in `proxies.txt`, sequential. If off: register `amount` once on the machine’s direct IP. |
| Output keys | Append base58 secrets to `{YYYY-MM-DD}_fresh_keys.txt` in the project root (local date). |
| Output tokens | On success, also write `accounts/tokens/{publicKey}.json` in the same shape AccountManager uses. |
| Concurrency | Proxies sequential. Within an IP, one signup at a time + delay. |
| Cancel | Stop between attempts after the in-flight signup finishes. |

## Architecture

```
RegisterTab  --POST-->  /api/register/start|stop
                              |
                              v
                       RegisterService
                              |
              +---------------+---------------+
              |               |               |
         loadProxyFile    Keypair.gen     signup(+proxy)
              |               |               |
              |               +--append--> {date}_fresh_keys.txt
              |               +--write---> accounts/tokens/{pk}.json
              v
         progress via existing UI WS / logs
```

### Components

1. **`src/ui/web/src/components/RegisterTab.tsx`**  
   Amount, delay, use-proxies, Start/Stop, status (current proxy, succeeded,
   failed, output filename). Match existing Run/Accounts styling.

2. **`src/ui/web/src/App.tsx`**  
   Add a third tab: Register.

3. **`src/ui/register-service.ts`** (new)  
   Cancelable job owning the IP loop, delays, wallet generation, persistence,
   and progress callbacks. Does not depend on keep-warm or viewer-service.

4. **`src/ui/server.ts`**  
   - `POST /api/register/start` body: `{ amountPerIp, delaySec, useProxies }`  
   - `POST /api/register/stop`  
   - Reject start if a register job is already running.  
   - Broadcast progress/logs on the existing UI WebSocket (same pattern as
     relogin / viewers).

5. **`src/auth.ts`**  
   Extend the HTTP path used by `getNonce` / `verifyWallet` / `signup` so an
   optional proxy agent can be passed (today signup is direct-only). Reuse
   `HttpsProxyAgent` + proxy URL construction consistent with
   `src/check-proxies.ts` / `ProxyConfig`.

### Persistence details

- **Fresh keys file:** `{YYYY-MM-DD}_fresh_keys.txt` at repo root. Create if
  missing; append one base58 secret per successful signup (newline-terminated).
  Multiple runs on the same calendar day append to the same file.
- **Tokens:** mirror AccountManager’s token JSON fields (`accessToken`,
  `refreshToken`, `cookies` as used by `writeTokens`). Prefer extracting a
  shared helper only if duplication is non-trivial; otherwise duplicate the
  small write in register-service to avoid coupling to AccountManager’s
  selection state.
- **Do not** update selection JSON, ban state, or `keys.txt`.

### Run algorithm

1. Validate inputs (`amountPerIp` in 1–3, `delaySec >= 0`).  
2. Build IP list: proxies from `loadProxyFile()` if `useProxies`, else `[direct]`.  
   If `useProxies` and the list is empty → fail start with a clear error.  
3. For each IP in order:  
   a. For `i` in `1..amountPerIp`:  
      - If stop requested → exit job.  
      - Generate wallet.  
      - Call `signup(wallet, …)` via that IP (or direct).  
      - On success: append key + write tokens; count success.  
      - On failure: log; **skip remaining slots on this IP**; go to next IP.  
      - If more signups remain on this IP and not stopping: sleep `delaySec`.  
4. Emit final summary (successes, failures, output path).

### Progress events

At minimum broadcast:

- `register:started` — config + output filename + IP count  
- `register:progress` — `{ ipIndex, ipLabel, attempt, succeeded, failed, message }`  
- `register:finished` / `register:stopped` — totals  

UI also appends human-readable lines to the shared log panel.

## Error handling

| Case | Behavior |
|------|----------|
| Rate limit / HTTP error on signup | Log; abandon remaining quota for that IP; continue to next IP. |
| Proxies enabled, empty `proxies.txt` | Do not start; return 400 with message. |
| Stop pressed mid-signup | Let current attempt complete; then halt without starting another. |
| Key or token write fails after successful signup | Log hard error; stop the job (avoid inventing accounts we cannot persist). |
| Job already running | Reject second start. |

## UI defaults

- Amount per IP: `3`  
- Delay: `5` seconds  
- Use proxies: `true` when `proxies.txt` has at least one valid line, else `false`  
  (optional `GET /api/register/defaults` or include proxy count on an existing
  status payload — implement whichever is smaller).

## Testing

- Unit tests with mocked `signup`:  
  - amount clamp / validation  
  - dated filename helper  
  - sequential IP processing  
  - skip remaining attempts on an IP after a failure  
  - stop flag honored between attempts  
  - successful path appends key and writes token file (temp dir)  
- No live Axiom network calls in automated tests.

## Out of scope follow-ups

- Merging `{date}_fresh_keys.txt` into `keys.txt` from the UI.  
- Captcha / Turnstile automation for signup.  
- Raising the per-IP cap above 3.
