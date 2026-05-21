import { useCallback, useEffect, useState } from "react";
import { ClipboardPaste, Loader2, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import type { LogEntry } from "@/components/LogPanel";

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
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEFAULT_MIN_GAP_MS = 20;
const DEFAULT_MAX_GAP_MS = 50;
const DEFAULT_CONCURRENCY = 1;

/**
 * Heuristic: pump.fun token CAs always end with "pump"; pair addresses don't.
 * If the user pasted something we can't classify, we treat it as a pair address
 * and let the server validate.
 */
function isLikelyCA(input: string): boolean {
  return /pump$/i.test(input.trim());
}

function parsePaste(text: string, knownAccounts: Set<string>) {
  const tokens = text
    .split(/[\n,\s\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const publicKeys: string[] = [];
  let ca: string | undefined;

  for (const token of tokens) {
    if (!BASE58.test(token)) continue;
    if (knownAccounts.has(token)) {
      publicKeys.push(token);
    } else if (!ca || /pump$/i.test(token)) {
      ca = token;
    }
  }

  return { ca, publicKeys };
}

export function RunTab({ onLog, refreshTick, onAccountsChanged }: Props) {
  const [input, setInput] = useState("");
  const [token, setToken] = useState<ResolvedToken | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [resolving, setResolving] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
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
      onLog("Enter a token CA or pair address", "error");
      return;
    }

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
        `Resolved ${isLikelyCA(trimmed) ? "CA" : "pair"} to ${t.ticker} (${t.pairAddress.slice(0, 6)}\u2026)`,
        "success",
      );

      const safeMin = Math.max(0, Math.floor(minGapMs));
      const safeMax = Math.max(safeMin, Math.floor(maxGapMs));
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
        setBusy(false);
        return;
      }
      onLog(
        `Started ${startData.connected} viewer(s) on ${t.ticker}`,
        "success",
      );
      setRunning(true);
    } catch (err: any) {
      onLog(`Error: ${err.message}`, "error");
      setResolving(false);
    } finally {
      setBusy(false);
    }
  }

  async function stopViewers() {
    setBusy(true);
    try {
      await fetch("/api/viewers/stop", { method: "POST" });
      onLog("Viewers stopped", "success");
      setRunning(false);
    } catch (err: any) {
      onLog(`Error: ${err.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Token CA or pair address
        </label>
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            disabled={running || busy}
          />
          <Button
            variant="outline"
            size="icon"
            onClick={pasteFromClipboard}
            disabled={running || busy || pasting}
            aria-label="Paste CA and accounts"
            title="Paste CA and selected accounts from clipboard"
          >
            {pasting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ClipboardPaste className="h-4 w-4" />
            )}
          </Button>
          {!running ? (
            <Button onClick={resolveAndStart} disabled={busy || !input.trim()}>
              {resolving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              <span className="ml-2">Start</span>
            </Button>
          ) : (
            <Button variant="destructive" onClick={stopViewers} disabled={busy}>
              <Square className="h-4 w-4" />
              <span className="ml-2">Stop</span>
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Delay between viewers (ms)
        </label>
        <div className="flex items-center gap-2">
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
            disabled={running || busy}
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
            disabled={running || busy}
            className="font-mono"
            aria-label="Maximum delay"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setMinGapMs(DEFAULT_MIN_GAP_MS);
              setMaxGapMs(DEFAULT_MAX_GAP_MS);
            }}
            disabled={running || busy}
            title="Reset to default 200–500 ms"
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
          disabled={running || busy}
          className="font-mono"
          aria-label="Concurrent handshakes"
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={bootstrapDisabled}
          onCheckedChange={(v) => setBootstrapDisabled(v === true)}
          disabled={running || busy}
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
    </div>
  );
}
