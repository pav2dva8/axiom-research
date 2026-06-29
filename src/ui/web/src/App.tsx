import { useEffect, useRef, useState, useCallback } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { RunTab } from '@/components/RunTab';
import { AccountsTab } from '@/components/AccountsTab';
import { LogPanel, type LogEntry } from '@/components/LogPanel';

interface Status {
  accounts: number;
  selected: number;
  activeViewers: number;
  keepWarm: boolean;
}

export type ViewerState = 'pending' | 'connecting' | 'connected' | 'failed';
export interface ViewerProgress {
  total: number;
  states: Record<string, ViewerState>;
}

let logIdCounter = 0;

export default function App() {
  const [status, setStatus] = useState<Status>({ accounts: 0, selected: 0, activeViewers: 0, keepWarm: false });
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [accountsRefreshTick, setAccountsRefreshTick] = useState(0);
  const [viewerProgress, setViewerProgress] = useState<ViewerProgress>({ total: 0, states: {} });
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
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (!Array.isArray(data)) return;
      setStatus((s) => ({
        ...s,
        accounts: data.length,
        selected: data.filter((a) => a.selected).length,
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
          setStatus((s) => ({
            ...s,
            accounts: msg.data.accounts ?? s.accounts,
            selected: msg.data.selected ?? s.selected,
            activeViewers: msg.data.activeViewers ?? s.activeViewers,
            keepWarm: msg.data.keepWarm ?? s.keepWarm,
          }));
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
          setViewerProgress({ total: msg.data.total ?? 0, states });
        } else if (msg.type === 'viewer-progress') {
          setViewerProgress((p) => ({
            total: msg.data.total ?? p.total,
            states: { ...p.states, [msg.data.publicKey]: msg.data.state as ViewerState },
          }));
          if (typeof msg.data.connected === 'number') {
            setStatus((s) => ({ ...s, activeViewers: msg.data.connected }));
          }
        } else if (msg.type === 'probe-progress') {
          const m: string = msg.data.message ?? '';
          const type: LogEntry['type'] = /throttl|FAIL|net::|429|longer than/i.test(m)
            ? 'error'
            : /Recovered|cooldown measured|\bOK\b/i.test(m)
              ? 'success'
              : 'info';
          addLog(`[probe] ${m}`, type);
        }
      };
    }
    connect();
    return () => wsRef.current?.close();
  }, [addLog, refreshAccounts]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold tracking-tight">axiom-viewer</span>
          <span className="text-xs text-muted-foreground">research</span>
        </div>
        <div className="flex items-center gap-4 font-mono text-xs">
          <span className="text-muted-foreground">
            selected <span className="text-foreground">{status.selected}/{status.accounts}</span>
          </span>
          <span className="text-muted-foreground">
            active <span className="text-foreground">{status.activeViewers}</span>
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Tabs defaultValue="run" className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-border px-4 py-2">
            <TabsList>
              <TabsTrigger value="run">Run</TabsTrigger>
              <TabsTrigger value="accounts">Accounts</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="run" forceMount className="m-0 flex-1 overflow-auto p-4 data-[state=inactive]:hidden">
            <RunTab onLog={addLog} refreshTick={accountsRefreshTick} onAccountsChanged={refreshAccounts} viewerProgress={viewerProgress} />
          </TabsContent>
          <TabsContent value="accounts" className="m-0 flex-1 overflow-auto p-4">
            <AccountsTab onLog={addLog} refreshTick={accountsRefreshTick} onChanged={refreshAccounts} keepWarmRunning={status.keepWarm} />
          </TabsContent>
        </Tabs>
      </main>

      <LogPanel entries={logEntries} />
    </div>
  );
}
