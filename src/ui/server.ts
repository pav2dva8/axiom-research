/**
 * Viewer Bot Web Server
 *
 * HTTP + WS for the React UI. Source of truth for accounts is keys.txt;
 * see account-manager.ts.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { AccountManager } from "./account-manager";
import { ViewerService, type TokenInfo } from "./viewer-service";
import { derivePumpPair, isPumpCa } from "../pump-pair";

const PORT = process.env.PORT || 3847;

const accountManager = new AccountManager();
const viewerService = new ViewerService();

const uiClients: Set<WebSocket> = new Set();

function broadcast(type: string, data: any): void {
  const message = JSON.stringify({ type, data });
  for (const client of uiClients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

function statusPayload() {
  return {
    accounts: accountManager.getAccountCount(),
    selected: accountManager.getSelectedCount(),
    activeViewers: viewerService.getActiveCount(),
    keepWarm: accountManager.isKeepWarmRunning(),
  };
}

function broadcastStatus(): void {
  broadcast("status", statusPayload());
}

// Total accounts in the current viewer run, for the live progress display.
let currentRunTotal = 0;

function broadcastViewerProgress(publicKey: string, state: string): void {
  broadcast("viewer-progress", {
    publicKey,
    state,
    connected: viewerService.getActiveCount(),
    total: currentRunTotal,
  });
}

viewerService.on("viewer-connecting", (pk: string) =>
  broadcastViewerProgress(pk, "connecting"),
);
viewerService.on("viewer-connected", (pk: string) => {
  broadcastViewerProgress(pk, "connected");
  broadcastStatus();
});
viewerService.on("viewer-failed", (pk: string) =>
  broadcastViewerProgress(pk, "failed"),
);
viewerService.on("viewer-disconnected", (pk: string) => {
  broadcastViewerProgress(pk, "disconnected");
  broadcastStatus();
});

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * The input is always either a bare token CA or a full axiom.trade link
 * (e.g. https://axiom.trade/meme/<pair>?chain=sol) whose embedded address is
 * the pair. Pull the base58 address out of whatever was pasted; a bare CA is
 * returned unchanged. Whether the input was a bare address (CA) or a link
 * (pair) is what classifies it below — not the address suffix.
 */
const BASE58_ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
function extractAddress(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(BASE58_ADDRESS);
  return match ? match[0] : trimmed;
}

async function ensureBrowserSession(): Promise<
  NonNullable<ReturnType<typeof viewerService.getBrowserSession>>
> {
  let session = viewerService.getBrowserSession();
  if (session) return session;
  broadcast("relogin-progress", {
    done: 0,
    total: 0,
    message: "Opening browser for CF bypass — complete the challenge...",
  });
  const { openBrowserSession } = await import("../browser-auth");
  session = await openBrowserSession();
  viewerService.setBrowserSession(session);
  accountManager.setBrowserSession(session);
  broadcast("relogin-progress", {
    done: 0,
    total: 0,
    message: "Browser ready.",
  });
  return session;
}

/**
 * /clipboard-pair-info is authenticated — it 502s with "Session invalid"
 * unless the request carries a valid auth-access-token. Return a logged-in
 * account's tokens for the CA lookup: prefer a selected account with a still
 * valid access token, otherwise refresh one (fast, uses the refresh token).
 * Returns null if no account has usable credentials (user must log in first).
 */
async function authTokensForResolve(
  session: NonNullable<ReturnType<typeof viewerService.getBrowserSession>>,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const selected = accountManager.loadSelectedAccounts();
  const pool =
    selected.length > 0 ? selected : accountManager.loadAllAccounts();
  if (pool.length === 0) return null;

  const valid = pool.find((a) => accountManager.isTokenValid(a.publicKey));
  if (valid)
    return { accessToken: valid.accessToken, refreshToken: valid.refreshToken };

  // No valid cached token — refresh one. Try a few in case some refresh
  // tokens are also stale.
  for (const a of pool.slice(0, 3)) {
    const ok = await accountManager
      .refreshAccount(a.publicKey, session)
      .catch(() => false);
    if (ok) {
      const fresh = accountManager.loadAccount(a.publicKey);
      if (fresh?.accessToken) {
        return {
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken,
        };
      }
    }
  }
  return null;
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    // GET /api/status
    if (pathname === "/api/status" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify(statusPayload()));
      return;
    }

    // GET /api/accounts
    if (pathname === "/api/accounts" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify(accountManager.listAccounts()));
      return;
    }

    // POST /api/accounts/select  { publicKey, selected }
    if (pathname === "/api/accounts/select" && req.method === "POST") {
      const { publicKey, selected } = JSON.parse(await readBody(req));
      if (typeof publicKey !== "string" || typeof selected !== "boolean") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "publicKey + selected required" }));
        return;
      }
      accountManager.setSelected(publicKey, selected);
      broadcast("accounts-changed", {});
      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/accounts/selection  { publicKeys: string[] }
    if (pathname === "/api/accounts/selection" && req.method === "POST") {
      const { publicKeys } = JSON.parse(await readBody(req));
      if (
        !Array.isArray(publicKeys) ||
        !publicKeys.every((k) => typeof k === "string")
      ) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "publicKeys array required" }));
        return;
      }
      accountManager.setSelection(publicKeys);
      broadcast("accounts-changed", {});
      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, selected: publicKeys.length }));
      return;
    }

    // POST /api/accounts/relogin  { publicKeys?: string[] }
    if (pathname === "/api/accounts/relogin" && req.method === "POST") {
      const body = await readBody(req).catch(() => "");
      let targets: string[] | undefined;
      try {
        if (body) {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed.publicKeys)) targets = parsed.publicKeys;
        }
      } catch {}

      res.writeHead(200);
      const result = await accountManager.reloginAccounts(
        targets,
        (done, total, message) => {
          broadcast("relogin-progress", { done, total, message });
        },
      );

      const session = accountManager.getBrowserSession();
      if (session) viewerService.setBrowserSession(session);

      broadcast("accounts-changed", {});
      broadcastStatus();
      res.end(JSON.stringify({ success: result.success, total: result.total }));
      return;
    }

    // POST /api/accounts/relogin/stop
    if (pathname === "/api/accounts/relogin/stop" && req.method === "POST") {
      accountManager.stopReloginAll();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/accounts/refresh  { publicKeys?: string[] }
    // Lighter-weight than relogin: just hits /refresh-access-token.
    if (pathname === "/api/accounts/refresh" && req.method === "POST") {
      const body = await readBody(req).catch(() => "");
      let targets: string[] | undefined;
      try {
        if (body) {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed.publicKeys)) targets = parsed.publicKeys;
        }
      } catch {}

      res.writeHead(200);
      const result = await accountManager.refreshAccounts(
        targets,
        (done, total, message) => {
          broadcast("relogin-progress", { done, total, message });
        },
      );

      const session = accountManager.getBrowserSession();
      if (session) viewerService.setBrowserSession(session);

      broadcast("accounts-changed", {});
      broadcastStatus();
      res.end(JSON.stringify({ success: result.success, total: result.total }));
      return;
    }

    // POST /api/accounts/keepwarm/start  { publicKeys?, delayMs?, thresholdMin? }
    // Refresh-only: keeps selected accounts logged in indefinitely. Never re-logins.
    if (pathname === "/api/accounts/keepwarm/start" && req.method === "POST") {
      const body = await readBody(req).catch(() => "");
      let targets: string[] | undefined;
      let delayMs: number | undefined;
      let thresholdMin: number | undefined;
      try {
        if (body) {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed.publicKeys)) targets = parsed.publicKeys;
          if (
            typeof parsed.delayMs === "number" &&
            Number.isFinite(parsed.delayMs)
          )
            delayMs = parsed.delayMs;
          if (
            typeof parsed.thresholdMin === "number" &&
            Number.isFinite(parsed.thresholdMin)
          )
            thresholdMin = parsed.thresholdMin;
        }
      } catch {}

      await accountManager.startKeepLoggedIn(
        targets,
        { delayMs, thresholdMin },
        (message, running) => {
          broadcast("keepwarm", { running, message });
        },
      );

      const session = accountManager.getBrowserSession();
      if (session) viewerService.setBrowserSession(session);

      broadcastStatus();
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          running: accountManager.isKeepWarmRunning(),
        }),
      );
      return;
    }

    // POST /api/accounts/keepwarm/stop
    if (pathname === "/api/accounts/keepwarm/stop" && req.method === "POST") {
      accountManager.stopKeepLoggedIn();
      broadcast("keepwarm", {
        running: false,
        message: "Keep-logged-in stopping...",
      });
      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/accounts/probe-limit  { publicKeys?: string[], cap?: number }
    // Fires refreshes back-to-back to measure the per-IP rate-limit ceiling +
    // cooldown. Cancellable via /api/accounts/relogin/stop.
    if (pathname === "/api/accounts/probe-limit" && req.method === "POST") {
      const body = await readBody(req).catch(() => "");
      let targets: string[] | undefined;
      let cap = 20;
      try {
        if (body) {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed.publicKeys)) targets = parsed.publicKeys;
          if (
            typeof parsed.cap === "number" &&
            Number.isFinite(parsed.cap) &&
            parsed.cap >= 1
          ) {
            cap = Math.floor(parsed.cap);
          }
        }
      } catch {}

      res.writeHead(200);
      const result = await accountManager.probeLimit(
        targets,
        cap,
        (message) => {
          broadcast("probe-progress", { message });
        },
      );

      const session = accountManager.getBrowserSession();
      if (session) viewerService.setBrowserSession(session);

      broadcast("accounts-changed", {});
      broadcastStatus();
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/resolve  { input }  — accepts a token CA or an axiom.trade link
    if (pathname === "/api/resolve" && req.method === "POST") {
      const { input } = JSON.parse(await readBody(req));
      if (typeof input !== "string" || !input.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "input required" }));
        return;
      }
      const value = extractAddress(input);
      // A bare address is a token CA (any suffix, not only "pump"); a full
      // axiom.trade link wraps the pair. The input is never a bare pair.
      const fromLink = value !== input.trim();

      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
        res.writeHead(400);
        res.end(
          JSON.stringify({ error: "No token CA or axiom link found in input" }),
        );
        return;
      }

      let pairAddress: string | null = null;
      let pairData: any = null;

      if (fromLink) {
        // The address inside an axiom.trade link is already the pair.
        pairAddress = value;
      } else {
        // Bare token CA → resolve to its pair. A pump.fun CA has a
        // deterministic bonding-curve PDA we can derive locally (fast, and it
        // survives a flaky api9/api2 502). Any other CA needs the
        // authenticated /clipboard-pair-info lookup.
        if (isPumpCa(value)) {
          pairAddress = derivePumpPair(value);
        }
        if (!pairAddress) {
          const session = await ensureBrowserSession();
          const auth = await authTokensForResolve(session);
          if (!auth) {
            res.writeHead(401);
            res.end(
              JSON.stringify({
                error:
                  "No logged-in account. Open the Accounts tab and log in an account, then resolve the CA.",
              }),
            );
            return;
          }
          const resolved = await session.resolvePairFromCa(
            value,
            auth.accessToken,
            auth.refreshToken,
          );
          if (resolved?.pairAddress) {
            pairAddress = resolved.pairAddress;
            pairData = resolved;
          }
        }
      }

      if (!pairAddress) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Could not resolve CA to pair" }));
        return;
      }

      // pairData (from resolvePairFromCa) may be null. Build minimal tokenInfo
      // from what we know — the WS protocol only requires pairAddress + chain.
      const tokenInfo: TokenInfo = pairData
        ? {
            pairAddress: pairData.pairAddress || pairAddress,
            tokenAddress:
              pairData.tokenAddress || pairData.baseToken?.address || "",
            ticker:
              pairData.ticker ||
              pairData.tokenTicker ||
              pairData.baseToken?.symbol ||
              "UNKNOWN",
            name:
              pairData.name ||
              pairData.tokenName ||
              pairData.baseToken?.name ||
              "Unknown Token",
            protocol: pairData.protocol || "Pump V1",
            isMigrated: pairData.isMigrated || false,
            supply:
              pairData.supply || pairData.baseToken?.totalSupply || 1000000000,
            price: pairData.price || pairData.priceUsd || 0,
          }
        : {
            pairAddress,
            tokenAddress: fromLink ? "" : value,
            ticker: "TOKEN",
            name: "Token",
            protocol: isPumpCa(value) ? "Pump V1" : "Unknown",
            isMigrated: false,
            supply: 1000000000,
            price: 0,
          };

      viewerService.setTokenInfo(tokenInfo);
      res.writeHead(200);
      res.end(JSON.stringify({ tokenInfo, derived: !pairData }));
      return;
    }

    // POST /api/viewers/start  { pairAddress, minGapMs?, maxGapMs?, bootstrapDisabled?, concurrency? }
    if (pathname === "/api/viewers/start" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const {
        pairAddress,
        minGapMs,
        maxGapMs,
        bootstrapDisabled,
        concurrency,
      } = body ?? {};
      if (typeof pairAddress !== "string" || !pairAddress.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "pairAddress required" }));
        return;
      }
      const minGapValid =
        typeof minGapMs === "number" &&
        Number.isFinite(minGapMs) &&
        minGapMs >= 0;
      const maxGapValid =
        typeof maxGapMs === "number" &&
        Number.isFinite(maxGapMs) &&
        maxGapMs >= 0;
      const concurrencyValid =
        typeof concurrency === "number" &&
        Number.isFinite(concurrency) &&
        concurrency >= 1;

      await ensureBrowserSession();

      // /api/resolve normally sets tokenInfo for the same pair. If somehow
      // missing, build a minimal placeholder — the WS protocol only requires
      // pairAddress + chain.
      const cached = viewerService.getTokenInfo();
      if (!cached || cached.pairAddress !== pairAddress) {
        viewerService.setTokenInfo({
          pairAddress,
          tokenAddress: "",
          ticker: "TOKEN",
          name: "Token",
          protocol: "Pump V1",
          isMigrated: false,
          supply: 1000000000,
          price: 0,
        });
      }

      const accounts = accountManager.loadSelectedAccounts();
      if (accounts.length === 0) {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error:
              "No accounts selected or none have valid tokens. Re-login first.",
          }),
        );
        return;
      }

      // Reset the live progress display: every account starts "pending".
      currentRunTotal = accounts.length;
      broadcast("viewer-run", {
        total: accounts.length,
        accounts: accounts.map((a) => a.publicKey),
      });

      const connected = await viewerService.connectAll(accounts, {
        ...(minGapValid ? { minGapMs } : {}),
        ...(maxGapValid ? { maxGapMs } : {}),
        ...(concurrencyValid ? { concurrency } : {}),
        bootstrapDisabled: bootstrapDisabled === true,
      });

      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ connected, total: accounts.length }));
      return;
    }

    // POST /api/viewers/stop  { mode?: 'force' | 'slow', delayMs?: number }
    if (pathname === "/api/viewers/stop" && req.method === "POST") {
      const body = await readBody(req).catch(() => "");
      let mode: "force" | "slow" = "force";
      let delayMs = 2000;
      try {
        if (body) {
          const parsed = JSON.parse(body);
          if (parsed.mode === "slow") mode = "slow";
          if (
            typeof parsed.delayMs === "number" &&
            Number.isFinite(parsed.delayMs)
          ) {
            delayMs = Math.max(0, Math.floor(parsed.delayMs));
          }
        }
      } catch {}

      if (mode === "slow") {
        const disconnected = await viewerService.disconnectSlowly(delayMs);
        if (viewerService.getActiveCount() === 0) {
          currentRunTotal = 0;
          broadcast("viewer-run", { total: 0, accounts: [] });
        }
        broadcastStatus();
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, disconnected }));
        return;
      }

      viewerService.disconnectAll();
      currentRunTotal = 0;
      broadcast("viewer-run", { total: 0, accounts: [] });
      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err: any) {
    console.error("[Server]", err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  let filePath = req.url || "/";
  const hasExt = path.extname(filePath).length > 0;
  if (!hasExt) filePath = "/index.html";

  const WEB_DIST = path.join(process.cwd(), "src/ui/web/dist");
  const fullPath = path.join(WEB_DIST, filePath);
  const ext = path.extname(fullPath);

  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
  };

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.setHeader("Content-Type", mimeTypes[ext] || "text/plain");
    res.writeHead(200);
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/api/")) handleApi(req, res);
  else serveStatic(req, res);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  uiClients.add(ws);
  ws.send(
    JSON.stringify({
      type: "status",
      data: statusPayload(),
    }),
  );
  ws.on("close", () => uiClients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`\n  Viewer Bot UI running at http://localhost:${PORT}\n`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  viewerService.disconnectAll();
  accountManager.closeBrowserSession().catch(() => {});
  server.close();
  process.exit(0);
});
