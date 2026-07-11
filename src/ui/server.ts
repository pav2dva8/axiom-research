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
import { AccountManager, type LoadedAccount } from "./account-manager";
import type { KeepWarmTimingInput } from "./keepwarm-config";
import {
  DeployWatchCanceledError,
  DeployWatcher,
  getDeployWatchConfig,
  loadDeployWatchEnvFile,
  type DeployWatchEvent,
} from "./deploy-watcher";
import { resolveDeployWatchTarget } from "./deploy-watch-target";
import {
  cancelDeployWatchRequestState,
  createDeployWatchRequestState,
  isDeployWatchRequestBusy,
  markDeployWatchPhase,
  shouldBroadcastDeployWatchEvent,
  throwIfDeployWatchRequestCanceled,
  type DeployWatchRequestState,
} from "./deploy-watch-request";
import { ViewerService } from "./viewer-service";
import {
  TokenResolveError,
  resolveTokenInput,
} from "./token-resolver";
import { installFileLogger, readCurrentLogTail } from "./logger";
import { limitAccountsForRun, normalizeSafetyMaxAccounts } from "./run-safety";
import { loadProxyFile } from "../proxy-groups";
import { freshKeysFilename, normalizeRegisterOptions } from "./register-config";
import { RegisterService, type RegisterProgress } from "./register-service";

const PORT = process.env.PORT || 3847;
const DEFAULT_RUN_SAFETY_MAX_ACCOUNTS = 2;
installFileLogger();
loadDeployWatchEnvFile();

const accountManager = new AccountManager();
const viewerService = new ViewerService();
const deployWatcher = new DeployWatcher();
const registerService = new RegisterService();

const uiClients: Set<WebSocket> = new Set();
let activeDeployWatchRequest: DeployWatchRequestState | null = null;

function broadcast(type: string, data: any): void {
  const message = JSON.stringify({ type, data });
  for (const client of uiClients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

function isDeployWatchBusy(): boolean {
  return (
    deployWatcher.isActive() ||
    (activeDeployWatchRequest !== null &&
      isDeployWatchRequestBusy(activeDeployWatchRequest))
  );
}

function isDeployWatchStatusActive(): boolean {
  return (
    deployWatcher.isActive() ||
    (activeDeployWatchRequest !== null &&
      !activeDeployWatchRequest.canceled)
  );
}

function statusPayload() {
  return {
    accounts: accountManager.getAccountCount(),
    selected: accountManager.getSelectedCount('run'),
    accountsSelected: accountManager.getSelectedCount('accounts'),
    runSelected: accountManager.getSelectedCount('run'),
    activeViewers: viewerService.getActiveCount(),
    keepWarm: accountManager.isKeepWarmRunning(),
    deployWatch: isDeployWatchStatusActive(),
    registerRunning: registerService.isRunning(),
  };
}

function broadcastStatus(): void {
  broadcast("status", statusPayload());
}

function proxySafetyGroups(accounts: LoadedAccount[]) {
  const accountByPk = new Map(accounts.map((account) => [account.publicKey, account]));
  return accountManager.listRunProxyGroups().groups.map((group) => ({
    accounts: group.accounts
      .map((account) => accountByPk.get(account.publicKey))
      .filter((account): account is LoadedAccount => !!account),
  }));
}

function broadcastDeployWatchEvent(
  event: DeployWatchEvent,
  request = activeDeployWatchRequest,
): void {
  if (request && !shouldBroadcastDeployWatchEvent(request, event)) {
    return;
  }

  broadcast("deploy-watch", event);
  broadcastStatus();
}

function cancelActiveDeployWatchRequest(message: string): void {
  const request = activeDeployWatchRequest;
  if (request) {
    const event = cancelDeployWatchRequestState(request, message);
    if (event) {
      broadcastDeployWatchEvent(event, request);
    }
  }

  deployWatcher.cancel(message);
}

const stopDeployWatchBroadcast = deployWatcher.onDeployWatch(
  (event: DeployWatchEvent) => {
    broadcastDeployWatchEvent(event);
  },
);

// Total accounts in the current viewer run, for the live progress display.
let currentRunTotal = 0;

function abortViewerRunForBan(message: string): void {
  cancelActiveDeployWatchRequest(message);
  viewerService.disconnectAll();
  currentRunTotal = 0;
  broadcast("viewer-run", { total: 0, accounts: [] });
  broadcastStatus();
}

function broadcastViewerProgress(publicKey: string, state: string): void {
  broadcast("viewer-progress", {
    publicKey,
    state,
    connected: viewerService.getActiveCount(),
    total: currentRunTotal,
  });
}

function broadcastRegisterProgress(progress: RegisterProgress): void {
  const type =
    progress.phase === "started"
      ? "register-started"
      : progress.phase === "progress"
        ? "register-progress"
        : "register-finished";
  broadcast(type, progress);
  broadcastStatus();
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

    // GET /api/logs/current — sanitized server log tail for diagnostics.
    if (pathname === "/api/logs/current" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify(readCurrentLogTail()));
      return;
    }

    // GET /api/accounts
    if (pathname === "/api/accounts" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify(accountManager.listAccounts()));
      return;
    }

    // GET /api/proxy-groups
    if (pathname === "/api/proxy-groups" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify(accountManager.listProxyGroups()));
      return;
    }

    // GET /api/run/accounts — viewer-only selection/status.
    if (pathname === "/api/run/accounts" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify(accountManager.listRunAccounts()));
      return;
    }

    // GET /api/run/proxy-groups — viewer-only selection/status, stable proxy layout.
    if (pathname === "/api/run/proxy-groups" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify(accountManager.listRunProxyGroups()));
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

    // POST /api/run/select  { publicKey, selected }
    if (pathname === "/api/run/select" && req.method === "POST") {
      const { publicKey, selected } = JSON.parse(await readBody(req));
      if (typeof publicKey !== "string" || typeof selected !== "boolean") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "publicKey + selected required" }));
        return;
      }
      accountManager.setRunSelected(publicKey, selected);
      broadcast("accounts-changed", {});
      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/run/selection  { publicKeys: string[] }
    if (pathname === "/api/run/selection" && req.method === "POST") {
      const { publicKeys } = JSON.parse(await readBody(req));
      if (
        !Array.isArray(publicKeys) ||
        !publicKeys.every((k) => typeof k === "string")
      ) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "publicKeys array required" }));
        return;
      }
      accountManager.setRunSelection(publicKeys);
      broadcast("accounts-changed", {});
      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, selected: accountManager.getSelectedCount('run') }));
      return;
    }

    // GET /api/register/defaults
    if (pathname === "/api/register/defaults" && req.method === "GET") {
      const proxies = loadProxyFile();
      const opts = normalizeRegisterOptions({
        useProxies: proxies.length > 0,
      });
      res.writeHead(200);
      res.end(JSON.stringify({
        ...opts,
        proxyCount: proxies.length,
        outputFile: freshKeysFilename(),
      }));
      return;
    }

    // POST /api/register/start  { amountPerIp?, delaySec?, useProxies? }
    if (pathname === "/api/register/start" && req.method === "POST") {
      if (registerService.isRunning()) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: "Register job already running" }));
        return;
      }

      const rawBody = await readBody(req).catch(() => "");
      const body = rawBody ? JSON.parse(rawBody) : {};
      const opts = normalizeRegisterOptions(body ?? {});

      (async () => {
        try {
          const final = await registerService.run(opts, broadcastRegisterProgress);
          if (final.phase !== "finished" && final.phase !== "stopped") {
            broadcastRegisterProgress(final);
          }
        } catch (err: any) {
          const progress = err?.progress as RegisterProgress | undefined;
          broadcastRegisterProgress(
            progress ?? {
              phase: "finished",
              message: err?.message ?? String(err),
              succeeded: 0,
              failed: 0,
              outputFile: path.join(process.cwd(), freshKeysFilename()),
            },
          );
        }
      })();

      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/register/stop
    if (pathname === "/api/register/stop" && req.method === "POST") {
      registerService.requestStop();
      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
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
      if (session && !accountManager.hasConfiguredProxies()) viewerService.setBrowserSession(session);
      if (result.banDetected) {
        abortViewerRunForBan("BAN signal detected — disconnected viewers and stopped account automation.");
        broadcast("relogin-progress", {
          done: result.total,
          total: result.total,
          message: "BAN signal detected — disconnected viewers and stopped account automation.",
        });
      }

      broadcast("accounts-changed", {});
      broadcastStatus();
      res.end(JSON.stringify(result));
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
      if (session && !accountManager.hasConfiguredProxies()) viewerService.setBrowserSession(session);
      if (result.banDetected) {
        abortViewerRunForBan("BAN signal detected — disconnected viewers and stopped account automation.");
        broadcast("relogin-progress", {
          done: result.total,
          total: result.total,
          message: "BAN signal detected — disconnected viewers and stopped account automation.",
        });
      }

      broadcast("accounts-changed", {});
      broadcastStatus();
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/accounts/filter-banned  { publicKeys?: string[], delayMinMs?, delayMaxMs? }
    // Explicit audit mode: force-refresh every selected account, continue after
    // Weird Error ban signals, and let AccountManager remove banned keys.
    if (pathname === "/api/accounts/filter-banned" && req.method === "POST") {
      const body = await readBody(req).catch(() => "");
      let targets: string[] | undefined;
      let delayMinMs = 5_000;
      let delayMaxMs = 10_000;
      try {
        if (body) {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed.publicKeys)) targets = parsed.publicKeys;
          if (typeof parsed.delayMinMs === "number" && Number.isFinite(parsed.delayMinMs)) {
            delayMinMs = Math.max(0, parsed.delayMinMs);
          }
          if (typeof parsed.delayMaxMs === "number" && Number.isFinite(parsed.delayMaxMs)) {
            delayMaxMs = Math.max(delayMinMs, parsed.delayMaxMs);
          }
        }
      } catch {}

      res.writeHead(200);
      const warmProxy = await accountManager.warmProxySessionsForAccounts(
        targets,
        {},
        (message, running) => {
          broadcast("keepwarm", { running, message });
        },
      );
      if (!warmProxy.ok) {
        broadcast("relogin-progress", {
          done: 0,
          total: warmProxy.accounts,
          message: warmProxy.error ?? "Could not warm proxy sessions for ban filter.",
        });
        broadcastStatus();
        res.end(JSON.stringify({
          success: 0,
          total: warmProxy.accounts,
          skippedFresh: 0,
          error: warmProxy.error ?? "Could not warm proxy sessions for ban filter.",
        }));
        return;
      }
      let result;
      try {
        result = await accountManager.refreshAccounts(
          targets,
          (done, total, message) => {
            broadcast("relogin-progress", { done, total, message });
          },
          {
            force: true,
            continueOnBan: true,
            delayMinMs,
            delayMaxMs,
          },
        );
      } finally {
        if (warmProxy.temporary) {
          accountManager.stopKeepLoggedIn();
        }
      }

      const session = accountManager.getBrowserSession();
      if (session && !accountManager.hasConfiguredProxies()) viewerService.setBrowserSession(session);
      broadcast("accounts-changed", {});
      broadcastStatus();
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/accounts/keepwarm/start  { publicKeys?, delayMs?, thresholdMin?, timing ranges... }
    // Refresh-only: keeps selected accounts logged in indefinitely. Never re-logins.
    if (pathname === "/api/accounts/keepwarm/start" && req.method === "POST") {
      const body = await readBody(req).catch(() => "");
      let targets: string[] | undefined;
      const timing: KeepWarmTimingInput = {};
      try {
        if (body) {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed.publicKeys)) targets = parsed.publicKeys;
          for (const key of [
            "delayMs",
            "thresholdMin",
            "groupStartDelayMinMs",
            "groupStartDelayMaxMs",
            "refreshDelayMinMs",
            "refreshDelayMaxMs",
            "refreshThresholdMinMin",
            "refreshThresholdMaxMin",
          ] as const) {
            if (typeof parsed[key] === "number" && Number.isFinite(parsed[key])) {
              timing[key] = parsed[key];
            }
          }
        }
      } catch {}

      await accountManager.startKeepLoggedIn(
        targets,
        {
          ...timing,
          onBanSignal: () => {
            abortViewerRunForBan("BAN signal detected during keep-warm — disconnected viewers and stopped account automation.");
            broadcast("accounts-changed", {});
          },
        },
        (message, running) => {
          broadcast("keepwarm", { running, message });
        },
      );

      const session = accountManager.getBrowserSession();
      if (session && !accountManager.hasConfiguredProxies()) viewerService.setBrowserSession(session);

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
      if (session && !accountManager.hasConfiguredProxies()) viewerService.setBrowserSession(session);

      broadcast("accounts-changed", {});
      broadcastStatus();
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/resolve  { input }  — accepts a token CA or an axiom.trade link
    if (pathname === "/api/resolve" && req.method === "POST") {
      const { input } = JSON.parse(await readBody(req));
      try {
        const result = resolveTokenInput(input);
        viewerService.setTokenInfo(result.tokenInfo);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err: any) {
        if (err instanceof TokenResolveError) {
          res.writeHead(err.status);
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        throw err;
      }
      return;
    }

    // POST /api/viewers/watch-deploy-start  { input, minGapMs?, maxGapMs?, groupStartDelayMinMs?, groupStartDelayMaxMs?, bootstrapDisabled? }
    if (pathname === "/api/viewers/watch-deploy-start" && req.method === "POST") {
      if (isDeployWatchBusy()) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: "A deploy watch is already active." }));
        return;
      }

      const body = JSON.parse(await readBody(req));
      const {
        input,
        minGapMs,
        maxGapMs,
        groupStartDelayMinMs,
        groupStartDelayMaxMs,
        bootstrapDisabled,
        safetyMaxAccounts,
      } = body ?? {};
      if (typeof input !== "string" || !input.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "input required" }));
        return;
      }

      let target;
      try {
        target = resolveDeployWatchTarget(input);
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      const { parsed, tokenInfo } = target;
      const request = createDeployWatchRequestState({
        ca: parsed.ca,
        pairAddress: parsed.pairAddress,
      });
      activeDeployWatchRequest = request;
      const minGapValid =
        typeof minGapMs === "number" &&
        Number.isFinite(minGapMs) &&
        minGapMs >= 0;
      const maxGapValid =
        typeof maxGapMs === "number" &&
        Number.isFinite(maxGapMs) &&
        maxGapMs >= 0;
      const groupStartDelayMinValid =
        typeof groupStartDelayMinMs === "number" &&
        Number.isFinite(groupStartDelayMinMs) &&
        groupStartDelayMinMs >= 0;
      const groupStartDelayMaxValid =
        typeof groupStartDelayMaxMs === "number" &&
        Number.isFinite(groupStartDelayMaxMs) &&
        groupStartDelayMaxMs >= 0;
      const runSafetyMaxAccounts = normalizeSafetyMaxAccounts(
        safetyMaxAccounts,
        DEFAULT_RUN_SAFETY_MAX_ACCOUNTS,
      );

      broadcastDeployWatchEvent({
        state: "preparing",
        message: `Preparing watch for CA ${parsed.ca}.`,
        ca: parsed.ca,
        pairAddress: parsed.pairAddress,
      }, request);

      let accounts: LoadedAccount[] = [];

      try {
        throwIfDeployWatchRequestCanceled(request);
        const proxyMode = accountManager.hasConfiguredProxies();
        if (!proxyMode) {
          await ensureBrowserSession();
        }
        throwIfDeployWatchRequestCanceled(request);
        viewerService.setTokenInfo(tokenInfo);

        accounts = accountManager.loadExplicitRunSelectedAccounts();
        if (accounts.length === 0) {
          broadcastDeployWatchEvent({
            state: "failed",
            message:
              "No accounts selected or none have valid tokens. Re-login first.",
            ca: parsed.ca,
            pairAddress: parsed.pairAddress,
          }, request);
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error:
                "No accounts selected or none have valid tokens. Re-login first.",
            }),
          );
          return;
        }

        const safety = limitAccountsForRun(
          accounts,
          runSafetyMaxAccounts,
          proxyMode ? proxySafetyGroups(accounts) : undefined,
        );
        accounts = safety.accounts;
        if (safety.limited) {
          console.warn(
            `[Viewer] Safety cap active: starting ${accounts.length}/${safety.selectedTotal} selected account(s).`,
          );
        }

        let groupPlan = proxyMode
          ? accountManager.getWarmProxyViewerGroups(accounts)
          : null;
        if (groupPlan && !groupPlan.ready) {
          broadcastDeployWatchEvent({
            state: "failed",
            message: groupPlan.error ?? "Start keep-warm first so proxy groups are ready.",
            ca: parsed.ca,
            pairAddress: parsed.pairAddress,
          }, request);
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error: groupPlan.error ?? "Start keep-warm first so proxy groups are ready.",
              missingGroups: groupPlan.missingGroups,
              missingAccounts: groupPlan.missingAccounts,
            }),
          );
          return;
        }

        throwIfDeployWatchRequestCanceled(request);
        markDeployWatchPhase(request, "watching");
        const detection = await deployWatcher.waitForDeploy(
          parsed,
          getDeployWatchConfig(),
        );
        throwIfDeployWatchRequestCanceled(request);

        markDeployWatchPhase(request, "starting");
        viewerService.setTokenInfo(tokenInfo);
        broadcastDeployWatchEvent({
          state: "starting",
          message: `Mint detected at slot ${detection.slot}; starting viewers.`,
          ca: parsed.ca,
          pairAddress: parsed.pairAddress,
        }, request);

        if (proxyMode) {
          groupPlan = accountManager.getWarmProxyViewerGroups(accounts);
          if (!groupPlan.ready) {
            broadcastDeployWatchEvent({
              state: "failed",
              message: groupPlan.error ?? "Start keep-warm first so proxy groups are ready.",
              ca: parsed.ca,
              pairAddress: parsed.pairAddress,
            }, request);
            res.writeHead(400);
            res.end(
              JSON.stringify({
                error: groupPlan.error ?? "Start keep-warm first so proxy groups are ready.",
                missingGroups: groupPlan.missingGroups,
                missingAccounts: groupPlan.missingAccounts,
              }),
            );
            return;
          }
        }

        currentRunTotal = accounts.length;
        broadcast("viewer-run", {
          total: accounts.length,
          accounts: accounts.map((a) => a.publicKey),
          groups: groupPlan
            ? groupPlan.groups.map((group) => ({
                id: group.id,
                label: group.label,
                accounts: group.accounts.map((a) => a.publicKey),
              }))
            : undefined,
        });

        const connected = groupPlan
          ? await viewerService.connectGroups(groupPlan.groups, {
              ...(minGapValid ? { minGapMs } : {}),
              ...(maxGapValid ? { maxGapMs } : {}),
              ...(groupStartDelayMinValid ? { groupStartDelayMinMs } : {}),
              ...(groupStartDelayMaxValid ? { groupStartDelayMaxMs } : {}),
              bootstrapDisabled: bootstrapDisabled === true,
            })
          : await viewerService.connectAll(accounts, {
              ...(minGapValid ? { minGapMs } : {}),
              ...(maxGapValid ? { maxGapMs } : {}),
              bootstrapDisabled: bootstrapDisabled === true,
            });
        throwIfDeployWatchRequestCanceled(request);

        broadcastStatus();
        res.writeHead(200);
        res.end(
          JSON.stringify({
            connected,
            total: accounts.length,
            selectedTotal: safety.selectedTotal,
            safetyLimited: safety.limited,
            safetyMaxAccounts: safety.maxAccounts,
            detectedAt: detection.detectedAt,
            slot: detection.slot,
            source: detection.source,
          }),
        );
        return;
      } catch (err: any) {
        if (err instanceof DeployWatchCanceledError) {
          const shouldResetViewerRun =
            activeDeployWatchRequest === request || request.phase === "starting";
          broadcastDeployWatchEvent({
            state: "canceled",
            message: err.message,
            ca: parsed.ca,
            pairAddress: parsed.pairAddress,
          }, request);
          if (shouldResetViewerRun) {
            currentRunTotal = 0;
            broadcast("viewer-run", { total: 0, accounts: [] });
          }
          broadcastStatus();
          res.writeHead(200);
          res.end(
            JSON.stringify({
              canceled: true,
              connected: 0,
              total: accounts.length,
            }),
          );
          return;
        }

        broadcastDeployWatchEvent({
          state: "failed",
          message: err.message,
          ca: parsed.ca,
          pairAddress: parsed.pairAddress,
        }, request);
        throw err;
      } finally {
        if (activeDeployWatchRequest === request) {
          activeDeployWatchRequest = null;
        }
        broadcastStatus();
      }
    }

    // POST /api/viewers/start  { pairAddress, minGapMs?, maxGapMs?, groupStartDelayMinMs?, groupStartDelayMaxMs?, bootstrapDisabled? }
    if (pathname === "/api/viewers/start" && req.method === "POST") {
      if (isDeployWatchBusy()) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: "A deploy watch is active." }));
        return;
      }

      const body = JSON.parse(await readBody(req));
      const {
        pairAddress,
        minGapMs,
        maxGapMs,
        groupStartDelayMinMs,
        groupStartDelayMaxMs,
        bootstrapDisabled,
        safetyMaxAccounts,
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
      const groupStartDelayMinValid =
        typeof groupStartDelayMinMs === "number" &&
        Number.isFinite(groupStartDelayMinMs) &&
        groupStartDelayMinMs >= 0;
      const groupStartDelayMaxValid =
        typeof groupStartDelayMaxMs === "number" &&
        Number.isFinite(groupStartDelayMaxMs) &&
        groupStartDelayMaxMs >= 0;
      const runSafetyMaxAccounts = normalizeSafetyMaxAccounts(
        safetyMaxAccounts,
        DEFAULT_RUN_SAFETY_MAX_ACCOUNTS,
      );

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

      let accounts = accountManager.loadExplicitRunSelectedAccounts();
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

      const safety = limitAccountsForRun(
        accounts,
        runSafetyMaxAccounts,
        accountManager.hasConfiguredProxies() ? proxySafetyGroups(accounts) : undefined,
      );
      accounts = safety.accounts;
      if (safety.limited) {
        console.warn(
          `[Viewer] Safety cap active: starting ${accounts.length}/${safety.selectedTotal} selected account(s).`,
        );
      }

      // Reset the live progress display: every account starts "pending".
      currentRunTotal = accounts.length;
      let connected = 0;

      if (accountManager.hasConfiguredProxies()) {
        const groupPlan = accountManager.getWarmProxyViewerGroups(accounts);
        if (!groupPlan.ready) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error: groupPlan.error ?? "Start keep-warm first so proxy groups are ready.",
              missingGroups: groupPlan.missingGroups,
              missingAccounts: groupPlan.missingAccounts,
            }),
          );
          return;
        }

        broadcast("viewer-run", {
          total: accounts.length,
          accounts: accounts.map((a) => a.publicKey),
          groups: groupPlan.groups.map((group) => ({
            id: group.id,
            label: group.label,
            accounts: group.accounts.map((a) => a.publicKey),
          })),
        });

        connected = await viewerService.connectGroups(groupPlan.groups, {
          ...(minGapValid ? { minGapMs } : {}),
          ...(maxGapValid ? { maxGapMs } : {}),
          ...(groupStartDelayMinValid ? { groupStartDelayMinMs } : {}),
          ...(groupStartDelayMaxValid ? { groupStartDelayMaxMs } : {}),
          bootstrapDisabled: bootstrapDisabled === true,
        });
      } else {
        await ensureBrowserSession();

        broadcast("viewer-run", {
          total: accounts.length,
          accounts: accounts.map((a) => a.publicKey),
        });

        connected = await viewerService.connectAll(accounts, {
          ...(minGapValid ? { minGapMs } : {}),
          ...(maxGapValid ? { maxGapMs } : {}),
          bootstrapDisabled: bootstrapDisabled === true,
        });
      }

      broadcastStatus();
      res.writeHead(200);
      res.end(JSON.stringify({
        connected,
        total: accounts.length,
        selectedTotal: safety.selectedTotal,
        safetyLimited: safety.limited,
        safetyMaxAccounts: safety.maxAccounts,
      }));
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

      cancelActiveDeployWatchRequest("Deploy watch canceled by Stop.");

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
  cancelActiveDeployWatchRequest("Server shutting down.");
  stopDeployWatchBroadcast();
  viewerService.disconnectAll();
  accountManager.closeBrowserSession().catch(() => {});
  server.close();
  process.exit(0);
});
