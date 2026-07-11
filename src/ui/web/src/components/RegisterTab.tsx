import { useEffect, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { LogEntry } from "@/components/LogPanel";
import type { RegisterProgress } from "@/App";

interface RegisterDefaults {
  amountPerIp: number;
  delaySec: number;
  useProxies: boolean;
  proxyCount: number;
  outputFile: string;
}

interface Props {
  onLog: (msg: string, type: LogEntry["type"]) => void;
  running: boolean;
  progress: RegisterProgress | null;
}

const DEFAULTS: RegisterDefaults = {
  amountPerIp: 3,
  delaySec: 5,
  useProxies: false,
  proxyCount: 0,
  outputFile: "",
};

function toNumber(value: string, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function clampAmountPerIp(value: number): number {
  return Math.min(3, Math.max(1, Math.floor(value)));
}

export function RegisterTab({ onLog, running, progress }: Props) {
  const [amountPerIp, setAmountPerIp] = useState(DEFAULTS.amountPerIp);
  const [delaySec, setDelaySec] = useState(DEFAULTS.delaySec);
  const [useProxies, setUseProxies] = useState(DEFAULTS.useProxies);
  const [proxyCount, setProxyCount] = useState(DEFAULTS.proxyCount);
  const [outputFile, setOutputFile] = useState(DEFAULTS.outputFile);
  const [succeeded, setSucceeded] = useState(0);
  const [failed, setFailed] = useState(0);
  const [loadingDefaults, setLoadingDefaults] = useState(true);
  const [pendingAction, setPendingAction] = useState<"start" | "stop" | null>(null);

  useEffect(() => {
    let canceled = false;
    async function loadDefaults() {
      setLoadingDefaults(true);
      try {
        const res = await fetch("/api/register/defaults");
        const data = await res.json();
        if (!res.ok) {
          onLog(`Register defaults failed: ${data.error ?? res.statusText}`, "error");
          return;
        }
        if (canceled) return;
        setAmountPerIp(
          clampAmountPerIp(
            Number.isFinite(data.amountPerIp) ? data.amountPerIp : DEFAULTS.amountPerIp,
          ),
        );
        setDelaySec(Number.isFinite(data.delaySec) ? data.delaySec : DEFAULTS.delaySec);
        setUseProxies(data.useProxies === true);
        setProxyCount(Number.isFinite(data.proxyCount) ? data.proxyCount : 0);
        setOutputFile(typeof data.outputFile === "string" ? data.outputFile : "");
      } catch (err: any) {
        if (!canceled) onLog(`Register defaults failed: ${err.message}`, "error");
      } finally {
        if (!canceled) setLoadingDefaults(false);
      }
    }
    loadDefaults();
    return () => {
      canceled = true;
    };
  }, [onLog]);

  useEffect(() => {
    if (!progress) return;
    setSucceeded(progress.succeeded);
    setFailed(progress.failed);
    if (progress.outputFile) setOutputFile(progress.outputFile);
  }, [progress]);

  async function startRegister() {
    setPendingAction("start");
    setSucceeded(0);
    setFailed(0);
    onLog("Starting register job...", "info");
    try {
      const res = await fetch("/api/register/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountPerIp: clampAmountPerIp(amountPerIp), delaySec, useProxies }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onLog(`Register start failed: ${data.error ?? res.statusText}`, "error");
        return;
      }
      onLog("Register job requested", "success");
    } catch (err: any) {
      onLog(`Register start failed: ${err.message}`, "error");
    } finally {
      setPendingAction(null);
    }
  }

  async function stopRegister() {
    setPendingAction("stop");
    onLog("Stopping register job...", "info");
    try {
      const res = await fetch("/api/register/stop", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onLog(`Register stop failed: ${data.error ?? res.statusText}`, "error");
        return;
      }
      onLog("Register stop requested", "success");
    } catch (err: any) {
      onLog(`Register stop failed: ${err.message}`, "error");
    } finally {
      setPendingAction(null);
    }
  }

  const controlsDisabled = running || pendingAction !== null || loadingDefaults;
  const startPending = pendingAction === "start";
  const stopPending = pendingAction === "stop";
  const canUseProxies = proxyCount > 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">Register</span>
          {running && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              running
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={startRegister} disabled={controlsDisabled} size="sm">
            {startPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-2 h-3.5 w-3.5" />
            )}
            Start
          </Button>
          <Button
            onClick={stopRegister}
            disabled={!running || stopPending}
            size="sm"
            variant="destructive"
          >
            {stopPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="mr-2 h-3.5 w-3.5" />
            )}
            Stop
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-md border border-border bg-card p-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>Accounts per IP</span>
          <Input
            type="number"
            min={1}
            max={3}
            step={1}
            value={Number.isFinite(amountPerIp) ? amountPerIp : ""}
            onChange={(event) => setAmountPerIp(clampAmountPerIp(toNumber(event.target.value, 1)))}
            disabled={controlsDisabled}
            className="font-mono"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>Delay between signups (s)</span>
          <Input
            type="number"
            min={0}
            step={1}
            value={Number.isFinite(delaySec) ? delaySec : ""}
            onChange={(event) => setDelaySec(Math.max(0, Math.floor(toNumber(event.target.value, 0))))}
            disabled={controlsDisabled}
            className="font-mono"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground md:col-span-2">
          <Checkbox
            checked={useProxies && canUseProxies}
            onCheckedChange={(value) => setUseProxies(value === true)}
            disabled={controlsDisabled || !canUseProxies}
            aria-label="Use proxies"
          />
          <span>
            Use proxies
            <span className="ml-2 font-mono text-foreground">{proxyCount}</span>
            <span className="ml-1">available</span>
          </span>
        </label>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-border bg-card p-3 font-mono text-xs">
        <dt className="text-muted-foreground">output</dt>
        <dd className="truncate">{outputFile || "loading"}</dd>
        <dt className="text-muted-foreground">succeeded</dt>
        <dd className="text-emerald-400">{succeeded}</dd>
        <dt className="text-muted-foreground">failed</dt>
        <dd className={failed > 0 ? "text-red-400" : "text-muted-foreground"}>{failed}</dd>
        {progress?.ipLabel && (
          <>
            <dt className="text-muted-foreground">current IP</dt>
            <dd className="truncate">{progress.ipLabel}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
