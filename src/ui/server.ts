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
  };
}

function broadcastStatus(): void {
  broadcast("status", statusPayload());
}

viewerService.on("viewer-connected", () => broadcastStatus());
viewerService.on("viewer-disconnected", () => broadcastStatus());

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** pump.fun token CAs always end with "pump"; pair addresses don't. */
function looksLikeCA(input: string): boolean {
  return /pump$/i.test(input.trim());
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

function tokenInfoFromPairData(pairAddress: string, data: any): TokenInfo {
  return {
    pairAddress: data.pairAddress || pairAddress,
    tokenAddress: data.tokenAddress || data.baseToken?.address || "",
    ticker: data.ticker || data.baseToken?.symbol || "UNKNOWN",
    name: data.name || data.baseToken?.name || "Unknown Token",
    protocol: data.protocol || "Pump V1",
    isMigrated: data.isMigrated || false,
    supply: data.supply || data.baseToken?.totalSupply || 1000000000,
    price: data.price || data.priceUsd || 0,
  };
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

    // POST /api/resolve  { input }  — accepts CA or pair address
    if (pathname === "/api/resolve" && req.method === "POST") {
      const { input } = JSON.parse(await readBody(req));
      if (typeof input !== "string" || !input.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "input required" }));
        return;
      }
      const value = input.trim();

      let pairAddress: string | null = null;
      let pairData: any = null;

      // Pump.fun CA → pair is a deterministic PDA. Derive it locally first
      // so a flaky api9/api2 (e.g. CF 502) doesn't block us. We still try
      // to enrich with metadata via the API afterwards.
      if (isPumpCa(value)) {
        pairAddress = derivePumpPair(value);
      }

      // If we still need the pair, or want richer metadata than just the
      // address, hit Axiom through the CF-bypassed browser.
      if (!pairAddress || !pairData) {
        const session = await ensureBrowserSession();

        if (!pairAddress) {
          if (looksLikeCA(value)) {
            const resolved = await session.resolvePairFromCa(value);
            if (resolved?.pairAddress) {
              pairAddress = resolved.pairAddress;
              pairData = resolved;
            }
          } else {
            pairAddress = value;
          }
        }

        if (pairAddress && !pairData) {
          pairData = await session.fetchPairInfo(pairAddress).catch(() => null);
        }
      }

      if (!pairAddress) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Could not resolve CA to pair" }));
        return;
      }

      // pairData may be null (Axiom down). Build minimal tokenInfo from
      // what we know — the WS protocol only requires pairAddress + chain.
      const tokenInfo: TokenInfo = pairData
        ? tokenInfoFromPairData(pairAddress, pairData)
        : {
            pairAddress,
            tokenAddress: isPumpCa(value) ? value : "",
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

    // POST /api/viewers/start  { pairAddress, minGapMs?, maxGapMs? }
    if (pathname === "/api/viewers/start" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { pairAddress, minGapMs, maxGapMs } = body ?? {};
      if (typeof pairAddress !== "string" || !pairAddress.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "pairAddress required" }));
        return;
      }
      const minGapValid = typeof minGapMs === "number" && Number.isFinite(minGapMs) && minGapMs >= 0;
      const maxGapValid = typeof maxGapMs === "number" && Number.isFinite(maxGapMs) && maxGapMs >= 0;

      await ensureBrowserSession();

      // /api/resolve normally sets tokenInfo for the same pair. Only refetch
      // when we don't have anything cached for this pair, and tolerate a
      // failure (we already have a valid pairAddress, which is all the WS
      // protocol actually needs).
      const cached = viewerService.getTokenInfo();
      if (!cached || cached.pairAddress !== pairAddress) {
        const session = viewerService.getBrowserSession();
        const havePair = session
          ? await session.fetchPairInfo(pairAddress).catch(() => null)
          : null;
        if (havePair) {
          viewerService.setTokenInfo(
            tokenInfoFromPairData(pairAddress, havePair),
          );
        } else {
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

      const connected = await viewerService.connectAll(accounts, {
        ...(minGapValid ? { minGapMs } : {}),
        ...(maxGapValid ? { maxGapMs } : {}),
      });

      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ connected, total: accounts.length }));
      return;
    }

    // POST /api/viewers/stop
    if (pathname === "/api/viewers/stop" && req.method === "POST") {
      viewerService.disconnectAll();
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
