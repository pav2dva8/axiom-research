import { useEffect, useRef, useState, useCallback } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { RunTab } from '@/components/RunTab';
import { AccountsTab } from '@/components/AccountsTab';
import { RegisterTab } from '@/components/RegisterTab';
import { LogPanel, type LogEntry } from '@/components/LogPanel';

interface Status {
  accounts: number;
  selected: number;
  accountsSelected?: number;
  runSelected?: number;
  activeViewers: number;
  keepWarm: boolean;
  deployWatch: boolean;
  registerRunning?: boolean;
}

export type ViewerState = 'pending' | 'connecting' | 'warmup' | 'connected' | 'failed' | 'disconnected';
export interface ViewerProgressGroup {
  id: number;
  label: string;
  accounts: string[];
}
export interface ViewerProgress {
  total: number;
  states: Record<string, ViewerState>;
  groups?: ViewerProgressGroup[];
}

export type DeployWatchState =
  | 'preparing'
  | 'watching'
  | 'detected'
  | 'starting'
  | 'canceled'
  | 'failed';

export interface DeployWatchProgress {
  state: DeployWatchState;
  message: string;
  ca: string;
  pairAddress?: string;
}

export interface RegisterProgress {
  phase: 'started' | 'progress' | 'finished' | 'stopped';
  message: string;
  succeeded: number;
  failed: number;
  outputFile: string;
  ipIndex?: number;
  ipLabel?: string;
  attempt?: number;
}

let logIdCounter = 0;

function isActiveDeployWatchState(state: DeployWatchState): boolean {
  return (
    state === 'preparing' ||
    state === 'watching' ||
    state === 'detected' ||
    state === 'starting'
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>({
    accounts: 0,
    selected: 0,
    activeViewers: 0,
    keepWarm: false,
    deployWatch: false,
  });
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [accountsRefreshTick, setAccountsRefreshTick] = useState(0);
  const [viewerProgress, setViewerProgress] = useState<ViewerProgress>({ total: 0, states: {} });
  const [deployWatch, setDeployWatch] = useState<DeployWatchProgress | null>(null);
  const [registerRunning, setRegisterRunning] = useState(false);
  const [registerProgress, setRegisterProgress] = useState<RegisterProgress | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    const entry: LogEntry = {
      id: ++logIdCounter,
      time: new Date().toLocaleTimeString(),
      message,
      type,
    };
    setLogEntries((prev) => [...prev.slice(-199), entry]);
  }, []);

  const refreshAccounts = useCallback(() => setAccountsRefreshTick((t) => t + 1), []);

  const syncAccountsSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/run/accounts');
      const data = await res.json();
      if (!Array.isArray(data)) return;
      setStatus((s) => ({
        ...s,
        accounts: data.length,
        selected: data.filter((a) => a.selected).length,
        runSelected: data.filter((a) => a.selected).length,
      }));
    } catch {
      // ignore — WS status will retry
    }
  }, []);

  useEffect(() => {
    syncAccountsSummary();
  }, [syncAccountsSummary, accountsRefreshTick]);

  useEffect(() => {
    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => addLog('Connected to server', 'success');
      ws.onclose = () => {
        addLog('Disconnected — reconnecting...', 'error');
        setTimeout(connect, 3000);
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status') {
          const deployWatchStatus = msg.data.deployWatch;
          setStatus((s) => ({
            ...s,
            accounts: msg.data.accounts ?? s.accounts,
            selected: msg.data.selected ?? s.selected,
            accountsSelected: msg.data.accountsSelected ?? s.accountsSelected,
            runSelected: msg.data.runSelected ?? msg.data.selected ?? s.runSelected,
            activeViewers: msg.data.activeViewers ?? s.activeViewers,
            keepWarm: msg.data.keepWarm ?? s.keepWarm,
            deployWatch: deployWatchStatus ?? s.deployWatch,
            registerRunning: msg.data.registerRunning ?? s.registerRunning,
          }));
          if (typeof msg.data.registerRunning === 'boolean') {
            setRegisterRunning(msg.data.registerRunning);
          }
          if (deployWatchStatus === false) {
            setDeployWatch((prev) =>
              prev && isActiveDeployWatchState(prev.state) ? null : prev,
            );
          }
        } else if (msg.type === 'keepwarm') {
          const m: string = msg.data.message ?? '';
          const type: LogEntry['type'] = /dead token|rate limit|no refresh token|error/i.test(m)
            ? 'error'
            : /refreshed|started/i.test(m)
              ? 'success'
              : 'info';
          addLog(`[keep] ${m}`, type);
          if (typeof msg.data.running === 'boolean') {
            setStatus((s) => ({ ...s, keepWarm: msg.data.running }));
          }
        } else if (msg.type === 'relogin-progress') {
          addLog(msg.data.message, 'info');
          if (msg.data.done === msg.data.total) refreshAccounts();
        } else if (msg.type === 'accounts-changed') {
          refreshAccounts();
        } else if (msg.type === 'viewer-run') {
          const states: Record<string, ViewerState> = {};
          for (const pk of msg.data.accounts ?? []) states[pk] = 'pending';
          setViewerProgress({
            total: msg.data.total ?? 0,
            states,
            groups: Array.isArray(msg.data.groups) ? msg.data.groups : undefined,
          });
        } else if (msg.type === 'viewer-progress') {
          setViewerProgress((p) => ({
            total: msg.data.total ?? p.total,
            states: { ...p.states, [msg.data.publicKey]: msg.data.state as ViewerState },
            groups: p.groups,
          }));
          if (typeof msg.data.connected === 'number') {
            setStatus((s) => ({ ...s, activeViewers: msg.data.connected }));
          }
        } else if (msg.type === 'deploy-watch') {
          const data = msg.data as DeployWatchProgress;
          setDeployWatch(data);
          const type: LogEntry['type'] =
            data.state === 'failed' || data.state === 'canceled'
              ? 'error'
              : data.state === 'detected' || data.state === 'starting'
                ? 'success'
                : 'info';
          addLog(`[watch] ${data.message}`, type);
          setStatus((s) => ({
            ...s,
            deployWatch: isActiveDeployWatchState(data.state),
          }));
        } else if (msg.type === 'probe-progress') {
          const m: string = msg.data.message ?? '';
          const type: LogEntry['type'] = /throttl|FAIL|net::|429|longer than/i.test(m)
            ? 'error'
            : /Recovered|cooldown measured|\bOK\b/i.test(m)
              ? 'success'
              : 'info';
          addLog(`[probe] ${m}`, type);
        } else if (
          msg.type === 'register-started' ||
          msg.type === 'register-progress' ||
          msg.type === 'register-finished'
        ) {
          const data = msg.data as RegisterProgress;
          setRegisterProgress(data);
          if (msg.type === 'register-started') setRegisterRunning(true);
          if (msg.type === 'register-finished') setRegisterRunning(false);
          const m: string = data.message ?? '';
          const type: LogEntry['type'] =
            msg.type === 'register-finished' && /fail|error/i.test(m)
              ? 'error'
              : msg.type === 'register-finished'
                ? 'success'
                : 'info';
          addLog(`[register] ${m}`, type);
        }
      };
    }
    connect();
    return () => wsRef.current?.close();
  }, [addLog, refreshAccounts]);

  return (
    <Tabs defaultValue="run" className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
        <TabsList className="h-8 rounded-md bg-secondary/60 p-0.5">
          <TabsTrigger value="run" className="h-7 rounded px-4 text-xs">
            Run
          </TabsTrigger>
          <TabsTrigger value="accounts" className="h-7 rounded px-4 text-xs">
            Accounts
          </TabsTrigger>
          <TabsTrigger value="register" className="h-7 rounded px-4 text-xs">
            Register
          </TabsTrigger>
        </TabsList>
        <div className="flex shrink-0 items-center gap-4 font-mono text-xs">
          <span className="text-muted-foreground">
            run selected <span className="text-foreground">{status.runSelected ?? status.selected}/{status.accounts}</span>
          </span>
          <span className="text-muted-foreground">
            active <span className="text-foreground">{status.activeViewers}</span>
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TabsContent value="run" forceMount className="m-0 flex-1 overflow-auto p-4 data-[state=inactive]:hidden">
            <RunTab
              onLog={addLog}
              refreshTick={accountsRefreshTick}
              onAccountsChanged={refreshAccounts}
              viewerProgress={viewerProgress}
              deployWatch={deployWatch}
              deployWatchActive={status.deployWatch}
              keepWarmRunning={status.keepWarm}
            />
          </TabsContent>
          <TabsContent value="accounts" className="m-0 flex-1 overflow-auto p-4">
            <AccountsTab onLog={addLog} refreshTick={accountsRefreshTick} onChanged={refreshAccounts} keepWarmRunning={status.keepWarm} />
          </TabsContent>
          <TabsContent value="register" className="m-0 flex-1 overflow-auto p-4">
            <RegisterTab onLog={addLog} running={registerRunning} progress={registerProgress} />
          </TabsContent>
      </main>

      <LogPanel entries={logEntries} />
    </Tabs>
  );
}
