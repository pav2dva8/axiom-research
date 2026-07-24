import { useCallback, useEffect, useState } from "react";
import { CheckCheck, ClipboardPaste, Loader2, Radar, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import type { LogEntry } from "@/components/LogPanel";
import type { DeployWatchProgress, ViewerProgress } from "@/App";
import {
  accountRunStatus,
  type AccountAuthStatus,
} from "@/lib/run-status";

interface ResolvedToken {
  pairAddress: string;
  tokenAddress: string;
  ticker: string;
  name: string;
}

interface Account {
  publicKey: string;
  selected: boolean;
  hasTokens: boolean;
  tokenValid: boolean;
  banned?: boolean;
}

interface ProxyAccountGroup {
  id: number;
  label: string;
  accounts: Account[];
}

interface ProxyGroupsPayload {
  enabled: boolean;
  totalProxies: number;
  groups: ProxyAccountGroup[];
}

interface Props {
  onLog: (msg: string, type: LogEntry["type"]) => void;
  refreshTick: number;
  onAccountsChanged: () => void;
  viewerProgress: ViewerProgress;
  deployWatch: DeployWatchProgress | null;
  deployWatchActive: boolean;
  keepWarmRunning: boolean;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
// Ethereum-style hex pair address (robinhood/bnb/eth chains).
const HEX_ADDRESS = /0x[a-fA-F0-9]{40}/;
const HEX_ADDRESS_EXACT = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_MIN_GAP_MS = 5000;
const DEFAULT_MAX_GAP_MS = 10000;
const DEFAULT_GROUP_START_MIN_MS = 5000;
const DEFAULT_GROUP_START_MAX_MS = 15000;
const DEFAULT_FRIENDS_RECONNECT_MS = 20_000;

function extractAddress(input: string): string {
  const trimmed = input.trim();
  // Solana base58 first (legacy), then Ethereum-style 0x for cross-chain tokens.
  const b58 = trimmed.match(BASE58_ADDRESS);
  if (b58) return b58[0];
  const hex = trimmed.match(HEX_ADDRESS);
  if (hex) return hex[0];
  return trimmed;
}

/** True when the input is an axiom link containing a token/pair address. */
function isLinkInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  const addr = extractAddress(trimmed);
  // It's a link only if the extracted address differs from the whole input
  // (i.e. there's surrounding URL text) AND the address is a valid token/pair.
  if (addr === trimmed) return false;
  return BASE58.test(addr) || HEX_ADDRESS_EXACT.test(addr);
}

/** True for a bare (non-link) token CA — base58 (sol) or 0x (cross-chain). */
function isBareCa(input: string): boolean {
  const trimmed = input.trim();
  return BASE58.test(trimmed) || HEX_ADDRESS_EXACT.test(trimmed);
}

function parsePaste(text: string, knownAccounts: Set<string>) {
  const tokens = text
    .split(/[\n,\s\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const publicKeys: string[] = [];
  let ca: string | undefined;

  for (const token of tokens) {
    const addr = extractAddress(token);
    // Accept sol (base58) or cross-chain (0x hex) token/pair addresses.
    if (!(BASE58.test(addr) || HEX_ADDRESS_EXACT.test(addr))) continue;
    if (knownAccounts.has(addr)) publicKeys.push(addr);
    else if (!ca) ca = token;
  }
  return { ca, publicKeys };
}

function normalizeDelayRange(minMs: number, maxMs: number) {
  const min = Math.max(0, Math.floor(Number.isFinite(minMs) ? minMs : 0));
  const max = Math.max(min, Math.floor(Number.isFinite(maxMs) ? maxMs : min));
  return { min, max };
}

function shortKey(pk: string) {
  return pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

export function TestTab({
  onLog,
  refreshTick,
  onAccountsChanged,
  viewerProgress,
  deployWatch,
  deployWatchActive,
  keepWarmRunning,
}: Props) {
  const [input, setInput] = useState("");
  const [token, setToken] = useState<ResolvedToken | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [proxyPlan, setProxyPlan] = useState<ProxyGroupsPayload>({ enabled: false, totalProxies: 0, groups: [] });
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [watching, setWatching] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [minGapMs, setMinGapMs] = useState(DEFAULT_MIN_GAP_MS);
  const [maxGapMs, setMaxGapMs] = useState(DEFAULT_MAX_GAP_MS);
  const [groupStartMinMs, setGroupStartMinMs] = useState(DEFAULT_GROUP_START_MIN_MS);
  const [groupStartMaxMs, setGroupStartMaxMs] = useState(DEFAULT_GROUP_START_MAX_MS);
  const [friendsReconnectMs, setFriendsReconnectMs] = useState(DEFAULT_FRIENDS_RECONNECT_MS);

  const fetchAccounts = useCallback(async () => {
    try {
      const [accountsRes, groupsRes] = await Promise.all([
        fetch("/api/test/accounts"),
        fetch("/api/test/proxy-groups"),
      ]);
      const data = await accountsRes.json();
      const groupsData = await groupsRes.json();
      setAccounts(Array.isArray(data) ? data : []);
      setProxyPlan(
        groupsData && Array.isArray(groupsData.groups)
          ? groupsData
          : { enabled: false, totalProxies: 0, groups: [] },
      );
    } catch (err: any) {
      onLog(`Failed to load test accounts: ${err.message}`, "error");
    }
  }, [onLog]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts, refreshTick]);

  useEffect(() => {
    if (!keepWarmRunning) return;
    const t = setInterval(fetchAccounts, 3000);
    return () => clearInterval(t);
  }, [fetchAccounts, keepWarmRunning]);

  useEffect(() => {
    if (viewerProgress.total === 0) setRunning(false);
  }, [viewerProgress.total]);

  const selectedCount = accounts.filter((a) => a.selected).length;
  const connectedCount = Object.values(viewerProgress.states).filter((s) => s === "connected").length;
  const isActive = running || watching || deployWatchActive || connectedCount > 0;
  const canWatchDeploy =
    !busy && !stopping && !isActive && input.trim().length > 0 && selectedCount > 0;
  const primaryPending = busy || watching || deployWatchActive;

  function applySelection(publicKeys: Set<string>) {
    setAccounts((prev) =>
      prev.map((account) => ({
        ...account,
        selected: account.tokenValid && publicKeys.has(account.publicKey),
      })),
    );
    setProxyPlan((prev) => ({
      ...prev,
      groups: prev.groups.map((group) => ({
        ...group,
        accounts: group.accounts.map((account) => ({
          ...account,
          selected: account.tokenValid && publicKeys.has(account.publicKey),
        })),
      })),
    }));
  }

  async function persistSelection(publicKeys: Set<string>) {
    setSelectionBusy(true);
    try {
      const res = await fetch("/api/test/selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKeys: [...publicKeys] }),
      });
      if (!res.ok) {
        const data = await res.json();
        onLog(`Test selection failed: ${data.error ?? res.statusText}`, "error");
        await fetchAccounts();
        return;
      }
      onAccountsChanged();
    } catch (err: any) {
      onLog(`Test selection error: ${err.message}`, "error");
      await fetchAccounts();
    } finally {
      setSelectionBusy(false);
    }
  }

  async function toggleAccount(publicKey: string, selected: boolean) {
    applySelection(
      new Set(
        accounts
          .filter((a) => (a.publicKey === publicKey ? selected : a.selected))
          .map((a) => a.publicKey),
      ),
    );
    setSelectionBusy(true);
    try {
      const res = await fetch("/api/test/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey, selected }),
      });
      if (!res.ok) {
        const data = await res.json();
        onLog(`Select failed: ${data.error ?? res.statusText}`, "error");
        await fetchAccounts();
        return;
      }
      onAccountsChanged();
    } catch (err: any) {
      onLog(`Select error: ${err.message}`, "error");
      await fetchAccounts();
    } finally {
      setSelectionBusy(false);
    }
  }

  async function selectAllValid() {
    const keys = new Set(accounts.filter((a) => a.tokenValid).map((a) => a.publicKey));
    applySelection(keys);
    await persistSelection(keys);
  }

  async function clearSelection() {
    applySelection(new Set());
    await persistSelection(new Set());
  }

  async function pasteFromClipboard() {
    setPasting(true);
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        onLog("Clipboard is empty", "error");
        return;
      }
      const known = new Set(accounts.map((a) => a.publicKey));
      const { ca, publicKeys } = parsePaste(text, known);
      if (ca) setInput(ca);
      if (publicKeys.length > 0) {
        const res = await fetch("/api/test/selection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicKeys }),
        });
        if (!res.ok) {
          const data = await res.json();
          onLog(`Selection failed: ${data.error ?? res.statusText}`, "error");
          return;
        }
        onAccountsChanged();
        await fetchAccounts();
      }
      const parts: string[] = [];
      if (ca) parts.push("CA");
      if (publicKeys.length > 0) parts.push(`${publicKeys.length} account(s)`);
      onLog(
        parts.length > 0 ? `Pasted ${parts.join(" + ")}` : "No valid CA or accounts in clipboard",
        parts.length > 0 ? "success" : "error",
      );
    } catch (err: any) {
      onLog(`Paste failed: ${err.message}`, "error");
    } finally {
      setPasting(false);
    }
  }

  async function resolveAndStart() {
    const trimmed = input.trim();
    const viewerDelay = normalizeDelayRange(minGapMs, maxGapMs);
    const groupDelay = normalizeDelayRange(groupStartMinMs, groupStartMaxMs);
    setBusy(true);
    setRunning(true);
    try {
      const resolveRes = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: trimmed }),
      });
      const resolveData = await resolveRes.json();
      if (!resolveRes.ok) {
        onLog(`Resolve failed: ${resolveData.error ?? resolveRes.statusText}`, "error");
        setRunning(false);
        return;
      }
      const t = resolveData.tokenInfo as ResolvedToken;
      setToken(t);
      onLog(`Resolved ${t.ticker || "TOKEN"} → ${t.pairAddress.slice(0, 8)}… (page-update)`, "info");

      const startRes = await fetch("/api/viewers/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairAddress: t.pairAddress,
          minGapMs: viewerDelay.min,
          maxGapMs: viewerDelay.max,
          groupStartDelayMinMs: groupDelay.min,
          groupStartDelayMaxMs: groupDelay.max,
          bootstrapDisabled: true,
          safetyMaxAccounts: 0,
          selectionScope: "test",
          navMode: "page-update",
          friendsReconnectDelayMs: Math.max(0, Math.floor(friendsReconnectMs)),
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) {
        onLog(`Minimal start failed: ${startData.error ?? startRes.statusText}`, "error");
        setRunning(false);
        return;
      }
      onLog(
        `Minimal watch started ${startData.connected} viewer(s) on ${t.ticker || "TOKEN"}`,
        "success",
      );
    } catch (err: any) {
      onLog(`Minimal start error: ${err.message}`, "error");
      setRunning(false);
    } finally {
      setBusy(false);
    }
  }

  async function watchDeployAndStart() {
    const trimmed = input.trim();
    if (isLinkInput(trimmed)) {
      await resolveAndStart();
      return;
    }
    if (!isBareCa(trimmed)) {
      onLog("Watch deploy requires a bare token CA", "error");
      return;
    }

    const viewerDelay = normalizeDelayRange(minGapMs, maxGapMs);
    const groupDelay = normalizeDelayRange(groupStartMinMs, groupStartMaxMs);
    setBusy(true);
    setRunning(true);
    setWatching(true);
    setToken(null);
    try {
      const res = await fetch("/api/viewers/watch-deploy-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: trimmed,
          minGapMs: viewerDelay.min,
          maxGapMs: viewerDelay.max,
          groupStartDelayMinMs: groupDelay.min,
          groupStartDelayMaxMs: groupDelay.max,
          bootstrapDisabled: true,
          safetyMaxAccounts: 0,
          selectionScope: "test",
          navMode: "page-update",
          friendsReconnectDelayMs: Math.max(0, Math.floor(friendsReconnectMs)),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onLog(`Minimal watch deploy failed: ${data.error ?? res.statusText}`, "error");
        setRunning(false);
        return;
      }
      if (data.canceled) {
        onLog("Watch deploy canceled", "info");
        setRunning(false);
        return;
      }
      onLog(
        `Minimal watch started ${data.connected ?? 0} viewer(s)`,
        "success",
      );
    } catch (err: any) {
      onLog(`Minimal watch deploy error: ${err.message}`, "error");
      setRunning(false);
    } finally {
      setWatching(false);
      setBusy(false);
    }
  }

  async function forceStop() {
    setBusy(true);
    try {
      await fetch("/api/viewers/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "force" }),
      });
      onLog("Force stopped all viewers", "success");
      setRunning(false);
      setStopping(false);
    } catch (err: any) {
      onLog(`Error: ${err.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function slowStop() {
    const viewerDelay = normalizeDelayRange(minGapMs, maxGapMs);
    setStopping(true);
    onLog(`Slow stop — ${viewerDelay.min}–${viewerDelay.max} ms gaps...`, "info");
    try {
      const res = await fetch("/api/viewers/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "slow",
          minGapMs: viewerDelay.min,
          maxGapMs: viewerDelay.max,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onLog(`Slow stop failed: ${(data as any).error ?? res.statusText}`, "error");
        return;
      }
      onLog("Slow stop finished", "success");
      setRunning(false);
    } catch (err: any) {
      onLog(`Slow stop error: ${err.message}`, "error");
    } finally {
      setStopping(false);
    }
  }

  function authStatus(a: Account): AccountAuthStatus {
    if (a.banned) return "banned";
    if (a.tokenValid) return "loggedIn";
    if (a.hasTokens) return "expired";
    return "needsLogin";
  }

  const rows = proxyPlan.enabled
    ? proxyPlan.groups.flatMap((g) => g.accounts.map((a) => ({ ...a, groupLabel: g.label })))
    : accounts.map((a) => ({ ...a, groupLabel: "" }));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Minimal watch test</h2>
        <p className="text-xs text-muted-foreground">
          Chrome: friends pageUpdate only (no token rooms). Watch logs for [Browser] viewer close times.
        </p>
        {!keepWarmRunning && (
          <p className="text-xs text-amber-400">
            Start Keep logged in on Accounts first (opens proxy browsers).
          </p>
        )}
        {keepWarmRunning && (
          <p className="text-xs text-emerald-400">keep-warm active</p>
        )}
        {deployWatch && (
          <p className="text-xs text-muted-foreground">
            Deploy watch: {deployWatch.state} — {deployWatch.message}
          </p>
        )}
        {token && (
          <p className="font-mono text-xs text-muted-foreground">
            Target {token.ticker} · {token.pairAddress.slice(0, 12)}…
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Token CA or axiom link
        </label>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(20rem,1fr)_auto_auto]">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            disabled={isActive || busy || stopping}
          />
          <Button
            variant="outline"
            size="icon"
            onClick={pasteFromClipboard}
            disabled={isActive || busy || pasting || stopping}
            aria-label="Paste"
          >
            {pasting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardPaste className="h-4 w-4" />}
          </Button>
          <Button onClick={watchDeployAndStart} disabled={!canWatchDeploy}>
            {primaryPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
            <span className="ml-2">Watch deploy</span>
          </Button>
        </div>
        {isActive && (
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={slowStop} disabled={stopping || connectedCount === 0}>
              {stopping ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-2 h-3.5 w-3.5" />}
              Slow stop
            </Button>
            <Button variant="destructive" size="sm" onClick={forceStop}>
              <Square className="mr-2 h-3.5 w-3.5" />
              Force stop
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Viewer gap (ms)
          <span className="flex items-center gap-1.5">
            <Input type="number" min={0} step={50} value={minGapMs} disabled={isActive || busy}
              onChange={(e) => setMinGapMs(Math.max(0, Number(e.target.value) || 0))} className="h-8 font-mono" />
            <span>–</span>
            <Input type="number" min={0} step={50} value={maxGapMs} disabled={isActive || busy}
              onChange={(e) => setMaxGapMs(Math.max(0, Number(e.target.value) || 0))} className="h-8 font-mono" />
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Group start (ms)
          <span className="flex items-center gap-1.5">
            <Input type="number" min={0} step={500} value={groupStartMinMs} disabled={isActive || busy}
              onChange={(e) => setGroupStartMinMs(Math.max(0, Number(e.target.value) || 0))} className="h-8 font-mono" />
            <span>–</span>
            <Input type="number" min={0} step={500} value={groupStartMaxMs} disabled={isActive || busy}
              onChange={(e) => setGroupStartMaxMs(Math.max(0, Number(e.target.value) || 0))} className="h-8 font-mono" />
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Friends reconnect (ms)
          <Input type="number" min={0} step={1000} value={friendsReconnectMs} disabled={isActive || busy}
            onChange={(e) => setFriendsReconnectMs(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            className="h-8 font-mono" />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          Test selected <span className="font-mono text-foreground">{selectedCount}</span>
          {viewerProgress.total > 0 && (
            <> · active <span className="font-mono text-foreground">{connectedCount}/{viewerProgress.total}</span></>
          )}
        </span>
        <Button size="sm" variant="outline" onClick={selectAllValid} disabled={selectionBusy || isActive}>
          <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
          All logged in
        </Button>
        <Button size="sm" variant="ghost" onClick={clearSelection} disabled={selectionBusy || isActive || selectedCount === 0}>
          Clear
        </Button>
      </div>

      <div className="rounded-md border border-border">
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr className="border-b border-border">
                <th className="w-10 px-3 py-2" />
                <th className="px-3 py-2 font-medium">Account</th>
                {proxyPlan.enabled && <th className="px-3 py-2 font-medium">Proxy</th>}
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const runStatus = accountRunStatus(authStatus(a), viewerProgress.states[a.publicKey]);
                return (
                  <tr key={a.publicKey} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">
                      <Checkbox
                        checked={a.selected}
                        disabled={!a.tokenValid || selectionBusy || isActive}
                        onCheckedChange={(v) => toggleAccount(a.publicKey, v === true)}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono">{shortKey(a.publicKey)}</td>
                    {proxyPlan.enabled && (
                      <td className="px-3 py-2 text-muted-foreground">{a.groupLabel}</td>
                    )}
                    <td className="px-3 py-2">
                      <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${runStatus.className}`}>
                        {runStatus.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                    No accounts loaded
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
