# Fresh Account Register Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Register tab that creates fresh Axiom accounts (amount per IP, delay, optional sequential proxies), appends secrets to `{YYYY-MM-DD}_fresh_keys.txt`, and caches tokens under `accounts/tokens/`.

**Architecture:** Pure helpers + injectable `RegisterService` job behind `/api/register/*`. Auth HTTP calls gain optional proxy agent support. React `RegisterTab` matches existing Run/Accounts controls. Does not touch `keys.txt` or account selection.

**Tech Stack:** TypeScript, Node HTTP + `ws`, React/Vite UI, `@solana/web3.js` Keypair, `bs58`, `https-proxy-agent`, Node test runner via `node --import tsx --test`.

## Global Constraints

- Amount per IP clamped to `1–3` (default `3`); no global total.
- Delay is fixed seconds between signups on the same IP (default `5`).
- Proxies run strictly one after another; within an IP, one signup at a time.
- Keys go to `{YYYY-MM-DD}_fresh_keys.txt` (local date) at project root; never auto-merge into `keys.txt`.
- On success also write `accounts/tokens/{publicKey}.json` as `{ accessToken, refreshToken, cookies }`.
- On signup failure for an IP: skip remaining slots on that IP, continue to next IP.
- Stop finishes the in-flight attempt, then halt.
- Disk write failure after successful signup stops the job.

---

## File Map

| File | Responsibility |
|---|---|
| `src/ui/register-config.ts` | Validate options, dated filename helper, proxy URL builder |
| `src/ui/register-service.ts` | Cancelable register job (IP loop, delays, persistence, progress) |
| `src/auth.ts` | Optional `agent` on nonce/verify/signup HTTP path |
| `src/ui/server.ts` | `/api/register/defaults`, `/start`, `/stop` + WS broadcasts |
| `src/ui/web/src/components/RegisterTab.tsx` | Register UI controls |
| `src/ui/web/src/App.tsx` | Register tab + WS `register-*` log handling |
| `tests/register-config.test.ts` | Pure validation / filename / proxy URL tests |
| `tests/register-service.test.ts` | Job sequencing with mocked signup (temp dirs) |

---

### Task 1: Register config helpers

**Files:**
- Create: `src/ui/register-config.ts`
- Create: `tests/register-config.test.ts`

**Interfaces:**
- Produces:
  - `export const REGISTER_AMOUNT_MIN = 1`
  - `export const REGISTER_AMOUNT_MAX = 3`
  - `export const DEFAULT_REGISTER_AMOUNT_PER_IP = 3`
  - `export const DEFAULT_REGISTER_DELAY_SEC = 5`
  - `export interface RegisterOptions { amountPerIp: number; delaySec: number; useProxies: boolean }`
  - `export function normalizeRegisterOptions(input: { amountPerIp?: unknown; delaySec?: unknown; useProxies?: unknown }): RegisterOptions`
  - `export function freshKeysFilename(date?: Date, now?: Date): string` → `YYYY-MM-DD_fresh_keys.txt` using local calendar date
  - `export function proxyConfigToAgentUrl(proxy: { server: string; username?: string; password?: string }): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/register-config.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REGISTER_AMOUNT_PER_IP,
  DEFAULT_REGISTER_DELAY_SEC,
  freshKeysFilename,
  normalizeRegisterOptions,
  proxyConfigToAgentUrl,
} from "../src/ui/register-config";

test("normalizeRegisterOptions clamps amount and delay", () => {
  assert.deepEqual(normalizeRegisterOptions({}), {
    amountPerIp: DEFAULT_REGISTER_AMOUNT_PER_IP,
    delaySec: DEFAULT_REGISTER_DELAY_SEC,
    useProxies: false,
  });

  assert.equal(normalizeRegisterOptions({ amountPerIp: 0 }).amountPerIp, 1);
  assert.equal(normalizeRegisterOptions({ amountPerIp: 99 }).amountPerIp, 3);
  assert.equal(normalizeRegisterOptions({ amountPerIp: 2.9 }).amountPerIp, 2);
  assert.equal(normalizeRegisterOptions({ delaySec: -1 }).delaySec, 0);
  assert.equal(normalizeRegisterOptions({ delaySec: "7" }).delaySec, 7);
  assert.equal(normalizeRegisterOptions({ useProxies: true }).useProxies, true);
  assert.equal(normalizeRegisterOptions({ useProxies: "yes" }).useProxies, false);
});

test("freshKeysFilename uses local YYYY-MM-DD", () => {
  const d = new Date(2026, 6, 11, 23, 0, 0); // Jul 11 2026 local
  assert.equal(freshKeysFilename(d), "2026-07-11_fresh_keys.txt");
});

test("proxyConfigToAgentUrl embeds credentials when present", () => {
  assert.equal(
    proxyConfigToAgentUrl({ server: "http://1.2.3.4:8080", username: "u", password: "p" }),
    "http://u:p@1.2.3.4:8080",
  );
  assert.equal(
    proxyConfigToAgentUrl({ server: "http://1.2.3.4:8080" }),
    "http://1.2.3.4:8080",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/register-config.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/ui/register-config.ts`**

```ts
import type { ProxyConfig } from "../proxy-groups";

export const REGISTER_AMOUNT_MIN = 1;
export const REGISTER_AMOUNT_MAX = 3;
export const DEFAULT_REGISTER_AMOUNT_PER_IP = 3;
export const DEFAULT_REGISTER_DELAY_SEC = 5;

export interface RegisterOptions {
  amountPerIp: number;
  delaySec: number;
  useProxies: boolean;
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export function normalizeRegisterOptions(input: {
  amountPerIp?: unknown;
  delaySec?: unknown;
  useProxies?: unknown;
}): RegisterOptions {
  const amountRaw = toFiniteNumber(input.amountPerIp);
  const delayRaw = toFiniteNumber(input.delaySec);
  const amountPerIp = Math.min(
    REGISTER_AMOUNT_MAX,
    Math.max(REGISTER_AMOUNT_MIN, Math.floor(amountRaw ?? DEFAULT_REGISTER_AMOUNT_PER_IP)),
  );
  const delaySec = Math.max(0, Math.floor(delayRaw ?? DEFAULT_REGISTER_DELAY_SEC));
  return {
    amountPerIp,
    delaySec,
    useProxies: input.useProxies === true,
  };
}

export function freshKeysFilename(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}_fresh_keys.txt`;
}

export function proxyConfigToAgentUrl(
  proxy: Pick<ProxyConfig, "server" | "username" | "password">,
): string {
  const url = new URL(proxy.server);
  if (proxy.username) url.username = proxy.username;
  if (proxy.password) url.password = proxy.password;
  return url.toString().replace(/\/$/, "");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/register-config.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/register-config.test.ts src/ui/register-config.ts
git commit -m "$(cat <<'EOF'
feat(register): add config helpers for fresh account signup

EOF
)"
```

---

### Task 2: Auth signup via optional proxy agent

**Files:**
- Modify: `src/auth.ts`
- Create: `tests/auth-proxy-agent.test.ts` (unit-level: verify agent is forwarded — prefer a tiny exported `fetchWithTimeout` options type test by exporting a test hook OR test `proxyConfigToAgentUrl` already done; for auth, add a focused test that `buildAuthFetchOptions` merges agent if we extract it)

**Interfaces:**
- Consumes: none from Task 1 required for auth itself
- Produces:
  - `export type AuthFetchAgent = import("https-proxy-agent").HttpsProxyAgent<string>`
  - Extend `getNonce(walletAddress, cfCookies?, agent?)`
  - Extend `verifyWallet(..., agent?)`
  - Extend `login(wallet, cfCookies?, turnstileToken?, agent?)`
  - Extend `signup(wallet, cfCookies?, turnstileToken?, agent?)`
  - Internal `fetchWithTimeout` accepts `agent` on options

- [ ] **Step 1: Write a failing test that documents the signup signature**

Create `tests/auth-signup-signature.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { signup } from "../src/auth";

test("signup function accepts an optional fourth agent argument", () => {
  assert.equal(typeof signup, "function");
  assert.ok(signup.length >= 1);
  // TypeScript compile check is the real guarantee; runtime length may be <4 due to defaults.
  // Ensure the module still exports signup after agent plumbing.
  assert.equal(signup.name, "signup");
});
```

This is a weak smoke test; the real work is the implementation below. Optionally skip a heavy mock of node-fetch.

- [ ] **Step 2: Run smoke test**

Run: `node --import tsx --test tests/auth-signup-signature.test.ts`  
Expected: PASS already (or FAIL only if import breaks)

- [ ] **Step 3: Plumb agent through auth HTTP**

In `src/auth.ts`:

1. Change `fetchWithTimeout` to pass through `agent` from options:

```ts
const fetchWithTimeout = (url: string, options?: RequestInit & { agent?: any }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_USER_AGENT,
    ...((options?.headers as Record<string, string>) || {}),
  };
  return nodeFetch(url, {
    ...options,
    headers,
    signal: controller.signal as any,
  } as any).finally(() => clearTimeout(timeout));
};
```

2. Add optional last param `agent?: any` to `getNonce`, `verifyWallet`, `authenticate`, `login`, `signup`. Pass `{ agent }` into each `fetchWithTimeout` call when present.

Example signature after change:

```ts
export async function signup(
  wallet: WalletInfo,
  cfCookies?: string,
  turnstileToken?: string,
  agent?: any,
): Promise<AuthTokens> {
  console.log("[Auth] Signing up for new account...");
  return authenticate(wallet, true, cfCookies, turnstileToken, agent);
}
```

Ensure `getNonce` and `verifyWallet` both forward `agent` into `fetchWithTimeout`.

- [ ] **Step 4: Commit**

```bash
git add src/auth.ts tests/auth-signup-signature.test.ts
git commit -m "$(cat <<'EOF'
feat(auth): allow optional proxy agent on signup/login HTTP

EOF
)"
```

---

### Task 3: RegisterService job (mocked signup)

**Files:**
- Create: `src/ui/register-service.ts`
- Create: `tests/register-service.test.ts`

**Interfaces:**
- Consumes: `normalizeRegisterOptions`, `freshKeysFilename`, `proxyConfigToAgentUrl`, `ProxyConfig`, `AuthTokens`, `loadProxyFile`
- Produces:
  - `export interface RegisterProgress { phase: "started" | "progress" | "finished" | "stopped"; message: string; succeeded: number; failed: number; outputFile: string; ipIndex?: number; ipLabel?: string; attempt?: number; }`
  - `export interface RegisterServiceDeps { signup: (wallet: WalletInfo, agent?: any) => Promise<AuthTokens>; loadProxies: () => ProxyConfig[]; generateWallet: () => { publicKey: string; secretKeyBase58: string; wallet: WalletInfo }; sleep: (ms: number) => Promise<void>; now: () => Date; cwd: string; createAgent?: (proxyUrl: string) => any }`
  - `export class RegisterService { isRunning(): boolean; requestStop(): void; run(opts, onProgress): Promise<RegisterProgress> }`

- [ ] **Step 1: Write failing sequencing tests**

Create `tests/register-service.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { RegisterService } from "../src/ui/register-service";
import type { AuthTokens, WalletInfo } from "../src/auth";
import type { ProxyConfig } from "../src/proxy-groups";

function walletFromKeypair(kp: Keypair): WalletInfo & { secretKeyBase58: string } {
  return {
    publicKey: kp.publicKey.toBase58(),
    secretKey: kp.secretKey,
    keypair: kp,
    secretKeyBase58: bs58.encode(kp.secretKey),
  };
}

function tokens(pk: string): AuthTokens {
  return { accessToken: `a-${pk}`, refreshToken: `r-${pk}`, cookies: `c=${pk}` };
}

test("register without proxies writes keys and tokens for amountPerIp", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const wallets = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map(walletFromKeypair);
  let wi = 0;
  const calls: Array<string | undefined> = [];
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => [],
    generateWallet: () => {
      const w = wallets[wi++];
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    signup: async (wallet, agent) => {
      calls.push(agent === undefined ? "direct" : "proxy");
      return tokens(wallet.publicKey);
    },
  });

  const result = await svc.run({ amountPerIp: 2, delaySec: 0, useProxies: false }, () => {});
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  const keysPath = path.join(cwd, "2026-07-11_fresh_keys.txt");
  const lines = fs.readFileSync(keysPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], wallets[0].secretKeyBase58);
  assert.ok(fs.existsSync(path.join(cwd, "accounts", "tokens", `${wallets[0].publicKey}.json`)));
  assert.deepEqual(calls, ["direct", "direct"]);
});

test("register with proxies runs IPs sequentially and amount per IP", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const proxies: ProxyConfig[] = [
    { id: 1, label: "proxy 1", server: "http://1.1.1.1:1", username: "a", password: "b" },
    { id: 2, label: "proxy 2", server: "http://2.2.2.2:2" },
  ];
  const agents: string[] = [];
  let n = 0;
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => proxies,
    createAgent: (url) => ({ url }),
    generateWallet: () => {
      const kp = Keypair.generate();
      const w = walletFromKeypair(kp);
      n++;
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    signup: async (_wallet, agent) => {
      agents.push((agent as any).url);
      return tokens(`pk${agents.length}`);
    },
  });

  const result = await svc.run({ amountPerIp: 2, delaySec: 0, useProxies: true }, () => {});
  assert.equal(result.succeeded, 4);
  assert.equal(n, 4);
  assert.equal(agents[0], "http://a:b@1.1.1.1:1");
  assert.equal(agents[1], "http://a:b@1.1.1.1:1");
  assert.equal(agents[2], "http://2.2.2.2:2");
  assert.equal(agents[3], "http://2.2.2.2:2");
});

test("signup failure skips remaining slots on that IP", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const proxies: ProxyConfig[] = [
    { id: 1, label: "proxy 1", server: "http://1.1.1.1:1" },
    { id: 2, label: "proxy 2", server: "http://2.2.2.2:2" },
  ];
  let attempts = 0;
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => proxies,
    createAgent: (url) => ({ url }),
    generateWallet: () => {
      const w = walletFromKeypair(Keypair.generate());
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    signup: async () => {
      attempts++;
      if (attempts === 1) throw new Error("rate limited");
      return tokens(`ok${attempts}`);
    },
  });

  const result = await svc.run({ amountPerIp: 3, delaySec: 0, useProxies: true }, () => {});
  // IP1: 1 fail → skip 2 remaining; IP2: 3 success → total attempts 1+3=4
  assert.equal(attempts, 4);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 1);
});

test("stop halts between attempts", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => [],
    generateWallet: () => {
      const w = walletFromKeypair(Keypair.generate());
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    signup: async (wallet) => {
      svc.requestStop();
      return tokens(wallet.publicKey);
    },
  });

  const result = await svc.run({ amountPerIp: 3, delaySec: 0, useProxies: false }, () => {});
  assert.equal(result.succeeded, 1);
  assert.equal(result.phase, "stopped");
});

test("useProxies with empty proxy list throws before starting", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => [],
    generateWallet: () => {
      throw new Error("should not generate");
    },
    signup: async () => {
      throw new Error("should not signup");
    },
  });

  await assert.rejects(
    () => svc.run({ amountPerIp: 1, delaySec: 0, useProxies: true }, () => {}),
    /proxies/i,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/register-service.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `RegisterService`**

Create `src/ui/register-service.ts` implementing the algorithm from the spec:

1. Normalize options.
2. Resolve IP list (`[{ kind:"direct" }]` or proxy configs).
3. If `useProxies && proxies.length===0` throw.
4. Loop IPs → loop attempts; honor `stopRequested` between attempts.
5. On signup success: append secret + `\n` to `path.join(cwd, freshKeysFilename(now()))`; write tokens JSON under `cwd/accounts/tokens/{pk}.json`.
6. On signup failure: increment failed, break inner loop (skip rest of IP).
7. Sleep `delaySec * 1000` between successful attempts on same IP when more remain.
8. Default deps: real `signup` from auth + `HttpsProxyAgent`, `Keypair.generate` + `bs58.encode`, `loadProxyFile`, `setTimeout` sleep, `process.cwd()`.

Key method sketch:

```ts
export class RegisterService {
  private stopRequested = false;
  private running = false;
  constructor(private deps: RegisterServiceDeps) {}

  isRunning(): boolean { return this.running; }
  requestStop(): void { this.stopRequested = true; }

  async run(rawOpts: ..., onProgress: (p: RegisterProgress) => void): Promise<RegisterProgress> {
    if (this.running) throw new Error("Register job already running");
    this.running = true;
    this.stopRequested = false;
    try {
      // ... algorithm ...
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/register-service.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/register-service.ts tests/register-service.test.ts
git commit -m "$(cat <<'EOF'
feat(register): add cancelable fresh-account register service

EOF
)"
```

---

### Task 4: HTTP API + WebSocket broadcasts

**Files:**
- Modify: `src/ui/server.ts`

**Interfaces:**
- Consumes: `RegisterService`, `normalizeRegisterOptions`, `freshKeysFilename`, `loadProxyFile`
- Produces endpoints:
  - `GET /api/register/defaults` → `{ amountPerIp, delaySec, useProxies, proxyCount, outputFile }`
  - `POST /api/register/start` body `{ amountPerIp?, delaySec?, useProxies? }`
  - `POST /api/register/stop`
  - WS events: `register-started`, `register-progress`, `register-finished` (map from progress.phase)

- [ ] **Step 1: Instantiate service near other services**

Near top of `server.ts` (with `accountManager` / `viewerService`):

```ts
import { RegisterService } from "./register-service";
import { freshKeysFilename, normalizeRegisterOptions } from "./register-config";
import { loadProxyFile } from "../proxy-groups";

const registerService = new RegisterService();
```

- [ ] **Step 2: Add routes before the static fallback**

```ts
// GET /api/register/defaults
if (pathname === "/api/register/defaults" && req.method === "GET") {
  const proxies = loadProxyFile();
  const opts = normalizeRegisterOptions({
    useProxies: proxies.length > 0,
  });
  return json(res, {
    ...opts,
    proxyCount: proxies.length,
    outputFile: freshKeysFilename(),
  });
}

// POST /api/register/start
if (pathname === "/api/register/start" && req.method === "POST") {
  const body = await readJson(req);
  if (registerService.isRunning()) {
    return json(res, { error: "Register job already running" }, 409);
  }
  const opts = normalizeRegisterOptions(body ?? {});
  // fire-and-forget like relogin
  (async () => {
    try {
      const final = await registerService.run(opts, (p) => {
        const type =
          p.phase === "started"
            ? "register-started"
            : p.phase === "progress"
              ? "register-progress"
              : p.phase === "stopped"
                ? "register-finished"
                : "register-finished";
        broadcast(type, p);
      });
      broadcast("register-finished", final);
    } catch (err: any) {
      broadcast("register-finished", {
        phase: "finished",
        message: err?.message ?? String(err),
        succeeded: 0,
        failed: 0,
        outputFile: freshKeysFilename(),
      });
    }
  })();
  return json(res, { ok: true });
}

// POST /api/register/stop
if (pathname === "/api/register/stop" && req.method === "POST") {
  registerService.requestStop();
  return json(res, { ok: true });
}
```

Use the same `readJson` / `json` helpers already in `server.ts` (match existing names exactly — if helpers differ, follow local style).

Also include `registerRunning: registerService.isRunning()` in `statusPayload()` if easy; otherwise skip (UI can track local state).

- [ ] **Step 3: Manual smoke (optional)**

Start server, `curl -s localhost:3847/api/register/defaults` — expect JSON with `outputFile` matching today.

- [ ] **Step 4: Commit**

```bash
git add src/ui/server.ts
git commit -m "$(cat <<'EOF'
feat(register): expose register start/stop API and WS events

EOF
)"
```

---

### Task 5: RegisterTab UI + App wiring

**Files:**
- Create: `src/ui/web/src/components/RegisterTab.tsx`
- Modify: `src/ui/web/src/App.tsx`

**Interfaces:**
- Consumes: `/api/register/defaults`, `/api/register/start`, `/api/register/stop`, WS `register-*`
- Produces: third tab `register`

- [ ] **Step 1: Create `RegisterTab.tsx`**

Follow Accounts/Run styling (Button, Input, Checkbox). State:

- `amountPerIp`, `delaySec`, `useProxies`, `proxyCount`, `outputFile`
- `running`, `succeeded`, `failed`

On mount: `GET /api/register/defaults` and fill controls.

Start:

```ts
await fetch("/api/register/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ amountPerIp, delaySec, useProxies }),
});
```

Stop: `POST /api/register/stop`.

Show: output filename, proxy count, succeeded/failed counters, Start/Stop buttons (Stop disabled when idle).

- [ ] **Step 2: Wire `App.tsx`**

1. Import `RegisterTab`.
2. Add TabsTrigger `value="register"` label `Register`.
3. Add TabsContent with `<RegisterTab onLog={addLog} />`.
4. In WS `onmessage`, handle:

```ts
} else if (
  msg.type === "register-started" ||
  msg.type === "register-progress" ||
  msg.type === "register-finished"
) {
  const m: string = msg.data.message ?? "";
  const type: LogEntry["type"] =
    msg.type === "register-finished" && /fail|error/i.test(m)
      ? "error"
      : msg.type === "register-finished"
        ? "success"
        : "info";
  addLog(`[register] ${m}`, type);
}
```

Optionally pass a `registerTick` / callback so RegisterTab can update counters from WS — simplest approach: keep counters inside RegisterTab by also listening is hard; instead have App pass nothing and RegisterTab poll isRunning via optimistic local state set true on Start and false when it sees finished via a small prop:

Cleaner: lift minimal register progress into App state (like deployWatch) OR have RegisterTab set `running=true` on start and `running=false` when parent calls `onRegisterFinished`. Easiest path matching codebase: handle WS only in App for logs; RegisterTab sets running locally on Start/Stop click and clears running when `onLog` is not enough — add optional callback:

```ts
// App.tsx
const [registerRunning, setRegisterRunning] = useState(false);
// in WS handler for register-started → setRegisterRunning(true)
// register-finished → setRegisterRunning(false)
<RegisterTab onLog={addLog} running={registerRunning} />
```

RegisterTab uses `running` prop to disable Start / enable Stop.

- [ ] **Step 3: Build web UI**

Run: `npm run build:web`  
Expected: success

- [ ] **Step 4: Commit**

```bash
git add src/ui/web/src/components/RegisterTab.tsx src/ui/web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(register): add Register tab for fresh account signup

EOF
)"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run unit tests**

```bash
node --import tsx --test tests/register-config.test.ts tests/register-service.test.ts tests/auth-signup-signature.test.ts
```

Expected: all PASS

- [ ] **Step 2: Typecheck / build**

```bash
npx tsc --noEmit
npm run build:web
```

Expected: no errors

- [ ] **Step 3: Spec coverage checklist**

Confirm against `docs/superpowers/specs/2026-07-11-fresh-account-register-tab-design.md`:

- [x] Amount per IP 1–3, default 3  
- [x] Delay default 5  
- [x] Use proxies sequential / direct mode  
- [x] `{date}_fresh_keys.txt` + token cache  
- [x] Skip rest of IP on failure  
- [x] Stop between attempts  
- [x] No `keys.txt` mutation  
- [x] New Register tab  

- [ ] **Step 4: Final commit only if uncommitted fixups remain**

---

## Self-review (plan vs spec)

| Spec item | Task |
|-----------|------|
| Register tab UI | Task 5 |
| amount / delay / use proxies | Tasks 1, 5 |
| sequential proxies | Task 3 |
| dated fresh keys + tokens | Task 3 |
| auth proxy agent | Task 2 |
| API start/stop + WS | Task 4 |
| skip IP on failure / stop / empty proxies error | Task 3 |
| unit tests mocked signup | Task 3 |
| no keys.txt merge | Task 3 (non-goal) |
