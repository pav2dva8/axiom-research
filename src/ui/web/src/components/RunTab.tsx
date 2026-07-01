import { useCallback, useEffect, useState } from "react";
import { ClipboardPaste, Loader2, Play, Radar, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import type { LogEntry } from "@/components/LogPanel";
import type { DeployWatchProgress, ViewerProgress, ViewerState } from "@/App";

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
}

interface Props {
  onLog: (msg: string, type: LogEntry["type"]) => void;
  refreshTick: number;
  onAccountsChanged: () => void;
  viewerProgress: ViewerProgress;
  deployWatch: DeployWatchProgress | null;
  deployWatchActive: boolean;
}

const STATE_STYLE: Record<ViewerState, string> = {
  pending: "bg-muted text-muted-foreground",
  connecting: "bg-amber-500/15 text-amber-400",
  connected: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-red-500/15 text-red-400",
  disconnected: "bg-muted/50 text-muted-foreground line-through",
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const DEFAULT_MIN_GAP_MS = 20;
const DEFAULT_MAX_GAP_MS = 50;
const DEFAULT_CONCURRENCY = 1;

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
      // Keep the original token (bare CA or full link) so Start can classify it.
      ca = token;
    }
  }

  return { ca, publicKeys };
}

export function RunTab({
  onLog,
  refreshTick,
  onAccountsChanged,
  viewerProgress,
  deployWatch,
  deployWatchActive,
}: Props) {
  const [input, setInput] = useState("");
  const [token, setToken] = useState<ResolvedToken | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [resolving, setResolving] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [watching, setWatching] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [minGapMs, setMinGapMs] = useState<number>(DEFAULT_MIN_GAP_MS);
  const [maxGapMs, setMaxGapMs] = useState<number>(DEFAULT_MAX_GAP_MS);
  const [concurrency, setConcurrency] = useState<number>(DEFAULT_CONCURRENCY);
  const [bootstrapDisabled, setBootstrapDisabled] = useState<boolean>(true);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts");
      const data = await res.json();
      setAccounts(Array.isArray(data) ? data : []);
    } catch (err: any) {
      onLog(`Failed to load accounts: ${err.message}`, "error");
    }
  }, [onLog]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts, refreshTick]);

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
        const res = await fetch("/api/accounts/selection", {
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

      const safeMin = Math.max(0, Math.floor(minGapMs));
      const safeMax = Math.max(safeMin, Math.floor(maxGapMs));
      setRunning(true);
      const startRes = await fetch("/api/viewers/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairAddress: t.pairAddress,
          minGapMs: safeMin,
          maxGapMs: safeMax,
          concurrency: Math.max(1, Math.floor(concurrency)),
          bootstrapDisabled,
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
        `Started ${startData.connected} viewer(s) on ${t.ticker}`,
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
    if (!BASE58.test(trimmed)) {
      onLog("Watch deploy requires a bare token CA", "error");
      return;
    }

    const safeMin = Math.max(0, Math.floor(minGapMs));
    const safeMax = Math.max(safeMin, Math.floor(maxGapMs));

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
          minGapMs: safeMin,
          maxGapMs: safeMax,
          concurrency: Math.max(1, Math.floor(concurrency)),
          bootstrapDisabled,
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
      onLog(`Started ${data.connected ?? 0} viewer(s) on TOKEN`, "success");
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
    BASE58.test(input.trim()) && !isActive && !busy && !stopping;
  const startPending = resolving || (busy && running && !watching && !watchActive);
  const watchPending = watching || watchActive;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Token CA or axiom link
        </label>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(20rem,1fr)_auto_auto_auto]">
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
            onClick={resolveAndStart}
            disabled={isActive || busy || stopping || !input.trim()}
          >
            {startPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            <span className="ml-2">Start</span>
          </Button>
          <Button
            variant="outline"
            onClick={watchDeployAndStart}
            disabled={!canWatchDeploy}
            title="Wait for the CA mint account to exist on-chain, then start viewers"
          >
            {watchPending ? (
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
          Concurrent handshakes (1 = serial)
        </label>
        <Input
          type="number"
          min={1}
          step={1}
          value={Number.isFinite(concurrency) ? concurrency : ""}
          onChange={(e) => {
            const v = e.target.value === "" ? 1 : Number(e.target.value);
            setConcurrency(Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1);
          }}
          disabled={isActive || busy || stopping}
          className="font-mono"
          aria-label="Concurrent handshakes"
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={bootstrapDisabled}
          onCheckedChange={(v) => setBootstrapDisabled(v === true)}
          disabled={isActive || busy || stopping}
        />
        <span>Skip bootstrap</span>
      </label>

      {token && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border bg-card p-3 font-mono text-xs">
          <dt className="text-muted-foreground">pair</dt>
          <dd className="truncate">{token.pairAddress}</dd>
          <dt className="text-muted-foreground">token</dt>
          <dd className="truncate">{token.tokenAddress || "—"}</dd>
        </dl>
      )}

      {!token && deployWatch?.pairAddress && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border bg-card p-3 font-mono text-xs">
          <dt className="text-muted-foreground">pair</dt>
          <dd className="truncate">{deployWatch.pairAddress}</dd>
          <dt className="text-muted-foreground">token</dt>
          <dd className="truncate">{deployWatch.ca}</dd>
        </dl>
      )}

      {progressEntries.length > 0 && (
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
          <div className="flex max-h-48 flex-wrap gap-1 overflow-auto">
            {progressEntries.map(([pk, st]) => (
              <span
                key={pk}
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${STATE_STYLE[st]}`}
                title={`${pk} — ${st}`}
              >
                {pk.slice(0, 4)}…{pk.slice(-4)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
