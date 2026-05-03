# Browser-Based Auth with Cloudflare Turnstile

## Problem

Axiom added Cloudflare Turnstile protection to their auth endpoints. Programmatic re-login fails because:
1. `POST /wallet-nonce` returns 404 without browser User-Agent (Cloudflare edge block)
2. `POST /verify-wallet-v2` now requires a `turnstileToken` field (Turnstile sitekey: `0x4AAAAAACb1mthF4yHVUfUh`)

## Solution

Use Playwright to open a headless Chromium browser, navigate to axiom.trade, solve the Turnstile challenge, and extract the token + Cloudflare cookies. Use those in the existing programmatic auth flow.

## Architecture

### New file: `src/browser-auth.ts`

Manages a Playwright browser session for obtaining Turnstile tokens and CF cookies.

**Exports:**

```typescript
interface BrowserSession {
  getTurnstileToken(): Promise<string>;
  getCookies(): Promise<string>;
  close(): Promise<void>;
}

async function openBrowserSession(): Promise<BrowserSession>;
```

**Flow:**
1. `openBrowserSession()` launches headless Chromium, navigates to `https://axiom.trade`, waits for Turnstile script to load
2. `getTurnstileToken()` renders an invisible Turnstile widget in the page, executes the challenge, returns the token string via the callback
3. `getCookies()` extracts all cookies from the browser context, returns them as a `Cookie` header string
4. `close()` closes browser and cleans up

**Batch usage pattern:**
```
session = openBrowserSession()
for each account:
  cookies = session.getCookies()
  nonce = getNonce(wallet, cookies)
  signature = sign(nonce, secretKey)
  token = session.getTurnstileToken()
  tokens = verifyWallet(wallet, nonce, signature, turnstileToken, cookies)
  saveTokens(tokens)
session.close()
```

### Changes to `src/auth.ts`

1. **`fetchWithProxy`**: Add `User-Agent` header (browser-like) to all requests
2. **`getNonce()`**:
   - Remove `v: Date.now()` from request body (browser doesn't send it)
   - Accept optional `cookies` parameter, send as `Cookie` header
3. **`verifyWallet()`**:
   - Add `turnstileToken` to request body
   - Accept optional `cookies` parameter, send as `Cookie` header

### Changes to `src/ui/account-manager.ts`

1. **`reloginAccount()`**: Accept optional `BrowserSession` parameter, use it to get Turnstile token and cookies
2. **`reloginAllAccounts()`**: Open one browser session, pass it to each `reloginAccount()` call, close after all accounts are processed

### Files not changed

- `src/client.ts` — WebSocket client unchanged
- `src/ui/viewer-service.ts` — viewer logic unchanged
- `src/ui/server.ts` — UI server unchanged
- `src/types.ts` — no new types needed

## Dependencies

- Add `playwright` to `dependencies` in `package.json`
- Run `npx playwright install chromium` after install

## Error Handling

- Browser launch failure: log error, fall back to existing behavior (will fail with 404/418, same as now)
- Turnstile timeout (30s): reject with error, skip account, continue to next
- Turnstile challenge failure: retry once, then skip account
- Page navigation during Turnstile solve: catch and retry

## Turnstile Widget Config

From Axiom's source code:
```javascript
window.turnstile.render(container, {
  sitekey: "0x4AAAAAACb1mthF4yHVUfUh",
  execution: "execute",
  appearance: "execute",
  callback: (token) => resolve(token),
  "error-callback": (err) => reject(err),
  "timeout-callback": () => reject("timeout")
});
window.turnstile.execute(container);
```
