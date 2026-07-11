import { useCallback, useEffect, useState } from "react";
import { CheckCheck, ClipboardPaste, Loader2, Radar, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import type { LogEntry } from "@/components/LogPanel";
import type { DeployWatchProgress, ViewerProgress, ViewerState } from "@/App";
import {
  accountRunStatus,
  VIEWER_STATUS_META,
  type AccountAuthStatus,
} from "@/lib/run-status";

interface ResolvedToken {
  pairAddress: string;
  tokenAddress: string;
  ticker: string;
  name: string;
  protocol: string;
  isMigrated: boolean;
  supply: number;
  price: number;
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

type BootstrapMode = "skip" | "run";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const DEFAULT_MIN_GAP_MS = 5000;
const DEFAULT_MAX_GAP_MS = 10000;
const DEFAULT_GROUP_START_MIN_MS = 5000;
const DEFAULT_GROUP_START_MAX_MS = 15000;
const DEFAULT_SAFETY_MAX_ACCOUNTS = 2;

/**
 * The input is always either a bare token CA or a full axiom.trade link
 * (e.g. https://axiom.trade/meme/<pair>?chain=sol) whose embedded address is
 * the pair. Pull the base58 address out of whatever was pasted; a bare CA is
 * returned unchanged so the server's CA-vs-pair logic can take over.
 */
function extractAddress(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(BASE58_ADDRESS);
  return match ? match[0] : trimmed;
}

function isLinkInput(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.length > 0 && extractAddress(trimmed) !== trimmed && BASE58.test(extractAddress(trimmed));
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
    if (!BASE58.test(addr)) continue;
    if (knownAccounts.has(addr)) {
      publicKeys.push(addr);
    } else if (!ca) {
      // Keep the original token (bare CA or full link) so the primary action can classify it.
      ca = token;
    }
  }

  return { ca, publicKeys };
}

function normalizeDelayRange(minMs: number, maxMs: number) {
  const min = Math.max(0, Math.floor(Number.isFinite(minMs) ? minMs : 0));
  const max = Math.max(min, Math.floor(Number.isFinite(maxMs) ? maxMs : min));
  return { min, max };
}

export function RunTab({
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
  const [previewingToken, setPreviewingToken] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [proxyPlan, setProxyPlan] = useState<ProxyGroupsPayload>({ enabled: false, totalProxies: 0, groups: [] });
  const [resolving, setResolving] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [watching, setWatching] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [minGapMs, setMinGapMs] = useState<number>(DEFAULT_MIN_GAP_MS);
  const [maxGapMs, setMaxGapMs] = useState<number>(DEFAULT_MAX_GAP_MS);
  const [groupStartMinMs, setGroupStartMinMs] = useState<number>(DEFAULT_GROUP_START_MIN_MS);
  const [groupStartMaxMs, setGroupStartMaxMs] = useState<number>(DEFAULT_GROUP_START_MAX_MS);
  const [safetyMaxAccounts, setSafetyMaxAccounts] = useState<number>(DEFAULT_SAFETY_MAX_ACCOUNTS);
  const [bootstrapMode, setBootstrapMode] = useState<BootstrapMode>("skip");

  const fetchAccounts = useCallback(async () => {
    try {
      const [accountsRes, groupsRes] = await Promise.all([
        fetch("/api/run/accounts"),
        fetch("/api/run/proxy-groups"),
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
      onLog(`Failed to load accounts: ${err.message}`, "error");
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
        const res = await fetch("/api/run/selection", {
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
        parts.length > 0
          ? `Pasted ${parts.join(" + ")}`
          : "No valid CA or accounts in clipboard",
        parts.length > 0 ? "success" : "error",
      );
    } catch (err: any) {
      onLog(`Paste failed: ${err.message}`, "error");
    } finally {
      setPasting(false);
    }
  }

  function applySelection(publicKeys: Set<string>) {
    setAccounts((prev) =>
      prev.map((account) => ({ ...account, selected: account.tokenValid && publicKeys.has(account.publicKey) })),
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
    applySelection(publicKeys);
    try {
      const res = await fetch("/api/run/selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKeys: [...publicKeys] }),
      });
      if (!res.ok) {
        const data = await res.json();
        onLog(`Selection failed: ${data.error ?? res.statusText}`, "error");
        await fetchAccounts();
        return;
      }
      onAccountsChanged();
      await fetchAccounts();
    } catch (err: any) {
      onLog(`Selection failed: ${err.message}`, "error");
      await fetchAccounts();
    } finally {
      setSelectionBusy(false);
    }
  }

  async function setWalletSelected(publicKey: string, selected: boolean) {
    const account = accounts.find((item) => item.publicKey === publicKey);
    if (selected && !account?.tokenValid) return;
    const next = new Set(accounts.filter((account) => account.selected).map((account) => account.publicKey));
    if (selected) next.add(publicKey);
    else next.delete(publicKey);
    await persistSelection(next);
  }

  async function setGroupSelected(group: ProxyAccountGroup, selected: boolean) {
    const next = new Set(accounts.filter((account) => account.selected).map((account) => account.publicKey));
    for (const account of group.accounts) {
      if (selected && account.tokenValid) next.add(account.publicKey);
      else next.delete(account.publicKey);
    }
    await persistSelection(next);
  }

  async function selectAllGood() {
    await persistSelection(new Set(accounts.filter((account) => account.tokenValid).map((account) => account.publicKey)));
  }

  async function resolveAndStart() {
    const trimmed = input.trim();
    if (!trimmed) {
      onLog("Enter a token CA or axiom.trade link", "error");
      return;
    }
    // A bare address is a token CA; a link wraps the pair. Send the raw input
    // so the server can tell which it was — stripping it to the bare address
    // would make a pair look like a CA.
    const fromLink = extractAddress(trimmed) !== trimmed;

    setBusy(true);
    setResolving(true);
    setWatching(false);
    setPreviewingToken(false);
    setPreviewError(null);
    try {
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: trimmed }),
      });
      const data = await res.json();
      if (!res.ok || !data.tokenInfo) {
        onLog(`Resolve failed: ${data.error ?? res.statusText}`, "error");
        setBusy(false);
        setResolving(false);
        return;
      }
      const t = data.tokenInfo as ResolvedToken;
      setToken(t);
      setResolving(false);
      onLog(
        `Resolved ${fromLink ? "pair" : "CA"} to ${t.ticker} (${t.pairAddress.slice(0, 6)}\u2026)`,
        "success",
      );

      const viewerDelay = normalizeDelayRange(minGapMs, maxGapMs);
      const groupDelay = normalizeDelayRange(groupStartMinMs, groupStartMaxMs);
      setRunning(true);
      const startRes = await fetch("/api/viewers/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairAddress: t.pairAddress,
          minGapMs: viewerDelay.min,
          maxGapMs: viewerDelay.max,
          groupStartDelayMinMs: groupDelay.min,
          groupStartDelayMaxMs: groupDelay.max,
          bootstrapDisabled: bootstrapMode === "skip",
          safetyMaxAccounts,
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) {
        onLog(
          `Start failed: ${startData.error ?? startRes.statusText}`,
          "error",
        );
        setRunning(false);
        setBusy(false);
        return;
      }
      onLog(
        startData.safetyLimited
          ? `Safety cap: started ${startData.connected}/${startData.selectedTotal} selected viewer(s) on ${t.ticker}`
          : `Started ${startData.connected} viewer(s) on ${t.ticker}`,
        "success",
      );
    } catch (err: any) {
      onLog(`Error: ${err.message}`, "error");
      setResolving(false);
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

    if (!BASE58.test(trimmed)) {
      onLog("Watch deploy requires a bare token CA", "error");
      return;
    }

    const viewerDelay = normalizeDelayRange(minGapMs, maxGapMs);
    const groupDelay = normalizeDelayRange(groupStartMinMs, groupStartMaxMs);

    setPreviewingToken(false);
    setPreviewError(null);
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
          bootstrapDisabled: bootstrapMode === "skip",
          safetyMaxAccounts,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onLog(`Watch deploy failed: ${data.error ?? res.statusText}`, "error");
        setRunning(false);
        return;
      }
      if (data.canceled) {
        onLog("Watch deploy canceled", "info");
        setRunning(false);
        return;
      }
      onLog(
        data.safetyLimited
          ? `Safety cap: started ${data.connected ?? 0}/${data.selectedTotal} selected viewer(s) on TOKEN`
          : `Started ${data.connected ?? 0} viewer(s) on TOKEN`,
        "success",
      );
    } catch (err: any) {
      onLog(`Watch deploy error: ${err.message}`, "error");
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
    setStopping(true);
    onLog("Slow stop — disconnecting 1 viewer/sec...", "info");
    try {
      const res = await fetch("/api/viewers/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "slow", delayMs: 2000 }),
      });
      const data = await res.json();
      onLog(
        `Slow stop done — disconnected ${data.disconnected ?? 0} viewer(s)`,
        "success",
      );
      setRunning(false);
    } catch (err: any) {
      onLog(`Error: ${err.message}`, "error");
    } finally {
      setStopping(false);
    }
  }

  const progressEntries = Object.entries(viewerProgress.states);
  const progressGroupKeys =
    proxyPlan.enabled && proxyPlan.groups.length > 0
      ? proxyPlan.groups.map((group) => ({
          id: group.id,
          label: group.label,
          accounts: group.accounts.map((account) => account.publicKey),
        }))
      : viewerProgress.groups ?? [];
  const groupedAccounts = new Set(progressGroupKeys.flatMap((group) => group.accounts));
  const ungroupedEntries = progressEntries.filter(([pk]) => !groupedAccounts.has(pk));
  const counts = progressEntries.reduce(
    (acc, [, st]) => {
      acc[st] = (acc[st] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const connectedCount = counts.connected ?? 0;
  const eventWatchActive =
    deployWatch?.state === "preparing" ||
    deployWatch?.state === "watching" ||
    deployWatch?.state === "detected" ||
    deployWatch?.state === "starting";
  const watchActive = deployWatchActive || eventWatchActive;
  const isActive =
    watchActive ||
    running ||
    connectedCount > 0 ||
    (counts.connecting ?? 0) > 0;
  const canWatchDeploy =
    (BASE58.test(input.trim()) || isLinkInput(input)) && !isActive && !busy && !stopping;
  const watchPending = watching || watchActive;
  const primaryPending = resolving || watchPending || (busy && running);
  const selectedCount = accounts.filter((account) => account.selected).length;
  const goodCount = accounts.filter((account) => account.tokenValid).length;
  const selectionDisabled = isActive || busy || stopping || selectionBusy;
  const accountStatus = (account: Account): AccountAuthStatus => {
    if (account.banned) return "banned";
    if (account.tokenValid) return "loggedIn";
    if (account.hasTokens) return "expired";
    return "needsLogin";
  };

  useEffect(() => {
    const trimmed = input.trim();
    const address = extractAddress(trimmed);

    if (!trimmed || !BASE58.test(address)) {
      setToken(null);
      setPreviewError(null);
      setPreviewingToken(false);
      return;
    }
    if (isActive || busy || stopping) return;

    let canceled = false;
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setPreviewingToken(true);
      setPreviewError(null);
      try {
        const res = await fetch("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: trimmed }),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (canceled) return;
        if (!res.ok || !data.tokenInfo) {
          setToken(null);
          setPreviewError(data.error ?? res.statusText);
          return;
        }
        setToken(data.tokenInfo as ResolvedToken);
      } catch (err: any) {
        if (canceled || err?.name === "AbortError") return;
        setToken(null);
        setPreviewError(err?.message || String(err));
      } finally {
        if (!canceled) setPreviewingToken(false);
      }
    }, 350);

    return () => {
      canceled = true;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [input, isActive, busy, stopping]);

  const renderViewerChip = (pk: string, st: ViewerState = "pending") => (
    <span
      key={pk}
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${VIEWER_STATUS_META[st].className}`}
      title={`${pk} — ${st}`}
    >
      {pk.slice(0, 4)}…{pk.slice(-4)}
    </span>
  );
  const renderGroupProgress = (publicKeys: string[]) => {
    const states = publicKeys.map((pk) => viewerProgress.states[pk]).filter(Boolean) as ViewerState[];
    const connected = states.filter((state) => state === "connected").length;
    const failed = states.filter((state) => state === "failed").length;
    const connecting = states.filter((state) => state === "connecting").length;
    if (states.length === 0) return null;
    return (
      <span className="font-mono text-muted-foreground">
        {connected}/{publicKeys.length}
        {connecting > 0 ? ` · ${connecting} connecting` : ""}
        {failed > 0 ? ` · ${failed} failed` : ""}
      </span>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
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
            aria-label="Paste CA and accounts"
            title="Paste CA and selected accounts from clipboard"
          >
            {pasting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ClipboardPaste className="h-4 w-4" />
            )}
          </Button>
          <Button
            onClick={watchDeployAndStart}
            disabled={!canWatchDeploy}
            title="Watch a bare CA for deploy, or start immediately from a full Axiom link"
          >
            {primaryPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Radar className="h-4 w-4" />
            )}
            <span className="ml-2">Watch deploy</span>
          </Button>
        </div>
        {isActive && (
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={slowStop}
              disabled={stopping || connectedCount === 0}
              title="Disconnect one viewer at a time (~1s apart)"
            >
              {stopping ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="mr-2 h-3.5 w-3.5" />
              )}
              Slow stop
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={forceStop}
              title="Immediately disconnect all viewers and cancel any in-progress connections"
            >
              <Square className="mr-2 h-3.5 w-3.5" />
              Force stop
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Delay between viewers (ms)
        </label>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
          <Input
            type="number"
            min={0}
            step={50}
            value={Number.isFinite(minGapMs) ? minGapMs : ""}
            onChange={(e) => {
              const v = e.target.value === "" ? 0 : Number(e.target.value);
              setMinGapMs(Number.isFinite(v) ? Math.max(0, v) : 0);
            }}
            onBlur={() => {
              if (maxGapMs < minGapMs) setMaxGapMs(minGapMs);
            }}
            disabled={isActive || busy || stopping}
            className="font-mono"
            aria-label="Minimum delay"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="number"
            min={0}
            step={50}
            value={Number.isFinite(maxGapMs) ? maxGapMs : ""}
            onChange={(e) => {
              const v = e.target.value === "" ? 0 : Number(e.target.value);
              setMaxGapMs(Number.isFinite(v) ? Math.max(0, v) : 0);
            }}
            onBlur={() => {
              if (maxGapMs < minGapMs) setMaxGapMs(minGapMs);
            }}
            disabled={isActive || busy || stopping}
            className="font-mono"
            aria-label="Maximum delay"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setMinGapMs(DEFAULT_MIN_GAP_MS);
              setMaxGapMs(DEFAULT_MAX_GAP_MS);
            }}
            disabled={isActive || busy || stopping}
            title={`Reset to default ${DEFAULT_MIN_GAP_MS}–${DEFAULT_MAX_GAP_MS} ms`}
            className="col-span-3 md:col-span-1"
          >
            Default
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Delay between groups (ms)
        </label>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
          <Input
            type="number"
            min={0}
            step={500}
            value={Number.isFinite(groupStartMinMs) ? groupStartMinMs : ""}
            onChange={(e) => {
              const v = e.target.value === "" ? 0 : Number(e.target.value);
              setGroupStartMinMs(Number.isFinite(v) ? Math.max(0, v) : 0);
            }}
            onBlur={() => {
              if (groupStartMaxMs < groupStartMinMs) setGroupStartMaxMs(groupStartMinMs);
            }}
            disabled={isActive || busy || stopping}
            className="font-mono"
            aria-label="Minimum group delay"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="number"
            min={0}
            step={500}
            value={Number.isFinite(groupStartMaxMs) ? groupStartMaxMs : ""}
            onChange={(e) => {
              const v = e.target.value === "" ? 0 : Number(e.target.value);
              setGroupStartMaxMs(Number.isFinite(v) ? Math.max(0, v) : 0);
            }}
            onBlur={() => {
              if (groupStartMaxMs < groupStartMinMs) setGroupStartMaxMs(groupStartMinMs);
            }}
            disabled={isActive || busy || stopping}
            className="font-mono"
            aria-label="Maximum group delay"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setGroupStartMinMs(DEFAULT_GROUP_START_MIN_MS);
              setGroupStartMaxMs(DEFAULT_GROUP_START_MAX_MS);
            }}
            disabled={isActive || busy || stopping}
            title={`Reset to default ${DEFAULT_GROUP_START_MIN_MS}–${DEFAULT_GROUP_START_MAX_MS} ms`}
            className="col-span-3 md:col-span-1"
          >
            Default
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Safety cap (accounts this run)
        </label>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <Input
            type="number"
            min={0}
            step={1}
            value={Number.isFinite(safetyMaxAccounts) ? safetyMaxAccounts : ""}
            onChange={(e) => {
              const v = e.target.value === "" ? 0 : Number(e.target.value);
              setSafetyMaxAccounts(Number.isFinite(v) ? Math.max(0, Math.floor(v)) : DEFAULT_SAFETY_MAX_ACCOUNTS);
            }}
            disabled={isActive || busy || stopping}
            className="font-mono"
            aria-label="Safety cap accounts"
            title="Default 2. Set 0 only when you intentionally want all selected accounts in one run."
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => setSafetyMaxAccounts(DEFAULT_SAFETY_MAX_ACCOUNTS)}
            disabled={isActive || busy || stopping}
            title={`Reset to default ${DEFAULT_SAFETY_MAX_ACCOUNTS} account canary`}
          >
            Default
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Bootstrap
        </label>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={bootstrapMode === "skip" ? "secondary" : "outline"}
            onClick={() => setBootstrapMode("skip")}
            disabled={isActive || busy || stopping}
            title="Default. Do not send the pre-viewer bootstrap request burst."
          >
            Skip
          </Button>
          <Button
            type="button"
            variant={bootstrapMode === "run" ? "secondary" : "outline"}
            onClick={() => setBootstrapMode("run")}
            disabled={isActive || busy || stopping}
            title="Run bootstrap before viewer handshakes when you intentionally want to test it."
          >
            Run
          </Button>
        </div>
      </div>

      {token && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border bg-card p-3 font-mono text-xs">
          <dt className="text-muted-foreground">pair</dt>
          <dd className="truncate">{token.pairAddress}</dd>
          <dt className="text-muted-foreground">token</dt>
          <dd className="truncate">{token.tokenAddress || "—"}</dd>
        </dl>
      )}

      {!token && previewingToken && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border bg-card p-3 font-mono text-xs">
          <dt className="text-muted-foreground">pair</dt>
          <dd className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            resolving
          </dd>
          <dt className="text-muted-foreground">token</dt>
          <dd className="truncate">{extractAddress(input)}</dd>
        </dl>
      )}

      {!token && !previewingToken && previewError && (
        <div className="rounded-md border border-red-500/25 bg-red-500/10 p-3 text-xs text-red-300">
          {previewError}
        </div>
      )}

      {!token && !previewingToken && deployWatch?.pairAddress && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border bg-card p-3 font-mono text-xs">
          <dt className="text-muted-foreground">pair</dt>
          <dd className="truncate">{deployWatch.pairAddress}</dd>
          <dt className="text-muted-foreground">token</dt>
          <dd className="truncate">{deployWatch.ca}</dd>
        </dl>
      )}

      {proxyPlan.enabled && proxyPlan.groups.length > 0 && (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium">Proxy groups</span>
              <span className="text-xs text-muted-foreground">
                {selectedCount}/{goodCount} good selected · {proxyPlan.groups.length}/{proxyPlan.totalProxies} active proxies
              </span>
              {keepWarmRunning && (
                <span className="text-xs text-emerald-400">keep-warm active</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {progressEntries.length > 0 && (
                <span className="font-mono text-xs text-muted-foreground">
                  {connectedCount}/{viewerProgress.total || progressEntries.length} connected
                  {(counts.failed ?? 0) > 0 ? ` · ${counts.failed} failed` : ""}
                </span>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={selectAllGood}
                disabled={goodCount === 0 || selectionDisabled}
                title="Select every account with a valid access token for viewer start"
              >
                <CheckCheck className="mr-2 h-3.5 w-3.5" />
                Select all good
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {proxyPlan.groups.map((group) => {
              const selectableAccounts = group.accounts.filter((account) => account.tokenValid);
              const groupSelected = selectableAccounts.filter((account) => account.selected).length;
              const allGroupSelected = selectableAccounts.length > 0 && groupSelected === selectableAccounts.length;
              const someGroupSelected = groupSelected > 0 && !allGroupSelected;
              const groupProgress = renderGroupProgress(group.accounts.map((account) => account.publicKey));

              return (
                <section key={group.id} className="border-t border-border/70 pt-3 first:border-t-0 lg:first:border-t lg:odd:border-t-0 lg:even:border-t-0">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <label className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        checked={allGroupSelected ? true : someGroupSelected ? "indeterminate" : false}
                        onCheckedChange={(value) => setGroupSelected(group, value === true)}
                        disabled={selectionDisabled || selectableAccounts.length === 0}
                      />
                      <span className="truncate text-sm font-medium">{group.label}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {groupSelected}/{selectableAccounts.length} good
                      </span>
                    </label>
                    {groupProgress}
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                    {group.accounts.map((account) => {
                      const progress = viewerProgress.states[account.publicKey];
                      const status = accountStatus(account);
                      const runStatus = accountRunStatus(status, progress);
                      const accountDisabled = selectionDisabled || !account.tokenValid;
                      return (
                        <label
                          key={account.publicKey}
                          className={`flex min-w-0 items-center gap-2 rounded border px-2 py-1.5 text-xs ${runStatus.className} ${accountDisabled ? "opacity-60" : ""}`}
                          title={`${account.publicKey} · ${runStatus.title}`}
                        >
                          <Checkbox
                            checked={account.selected && account.tokenValid}
                            onCheckedChange={(value) => setWalletSelected(account.publicKey, value === true)}
                            disabled={accountDisabled}
                            className="h-3.5 w-3.5"
                          />
                          <span className="min-w-0 flex-1 truncate font-mono">
                            {account.publicKey.slice(0, 5)}…{account.publicKey.slice(-5)}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] opacity-80">
                            {runStatus.label}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {progressEntries.length > 0 && !proxyPlan.enabled && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">
              {connectedCount}/{viewerProgress.total || progressEntries.length}{" "}
              connected
            </span>
            <span className="flex gap-2 font-mono text-muted-foreground">
              {(counts.connecting ?? 0) > 0 && (
                <span className="text-amber-400">
                  {counts.connecting} connecting
                </span>
              )}
              {(counts.pending ?? 0) > 0 && (
                <span>{counts.pending} pending</span>
              )}
              {(counts.failed ?? 0) > 0 && (
                <span className="text-red-400">{counts.failed} failed</span>
              )}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {progressGroupKeys.length > 0 ? (
              <>
                {progressGroupKeys.map((group) => {
                  const groupStates = group.accounts.map((pk) => viewerProgress.states[pk] ?? "pending");
                  const groupConnected = groupStates.filter((state) => state === "connected").length;
                  const groupFailed = groupStates.filter((state) => state === "failed").length;
                  const groupConnecting = groupStates.filter((state) => state === "connecting").length;

                  return (
                    <section key={group.id} className="border-t border-border/70 pt-2 first:border-t-0 first:pt-0">
                      <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                        <span className="font-medium">{group.label}</span>
                        <span className="font-mono text-muted-foreground">
                          {groupConnected}/{group.accounts.length}
                          {groupConnecting > 0 ? ` · ${groupConnecting} connecting` : ""}
                          {groupFailed > 0 ? ` · ${groupFailed} failed` : ""}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {group.accounts.map((pk) => renderViewerChip(pk, viewerProgress.states[pk] ?? "pending"))}
                      </div>
                    </section>
                  );
                })}
                {ungroupedEntries.length > 0 && (
                  <section className="border-t border-border/70 pt-2">
                    <div className="mb-1 text-xs font-medium">Ungrouped</div>
                    <div className="flex flex-wrap gap-1">
                      {ungroupedEntries.map(([pk, st]) => renderViewerChip(pk, st))}
                    </div>
                  </section>
                )}
              </>
            ) : (
              <div className="flex flex-wrap gap-1">
                {progressEntries.map(([pk, st]) => renderViewerChip(pk, st))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
