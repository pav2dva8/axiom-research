import { useEffect, useRef, useState, useCallback } from 'react';
import { StatusBar } from '@/components/StatusBar';
import { AccountsPanel } from '@/components/AccountsPanel';
import { ViewersPanel } from '@/components/ViewersPanel';
import { LogPanel, type LogEntry } from '@/components/LogPanel';

interface Status {
  accounts: number;
  activeViewers: number;
}

let logIdCounter = 0;

export default function App() {
  const [status, setStatus] = useState<Status>({ accounts: 0, activeViewers: 0 });
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    const entry: LogEntry = {
      id: ++logIdCounter,
      time: new Date().toLocaleTimeString(),
      message,
      type,
    };
    setLogEntries((prev) => [...prev.slice(-99), entry]);
  }, []);

  useEffect(() => {
    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}`);
      wsRef.current = ws;

      ws.onopen = () => addLog('Connected to server', 'success');
      ws.onclose = () => {
        addLog('Disconnected — reconnecting...', 'error');
        setTimeout(connect, 3000);
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status') {
          setStatus({ accounts: msg.data.accounts, activeViewers: msg.data.activeViewers });
        } else if (msg.type === 'relogin-progress') {
          addLog(`[${msg.data.done}/${msg.data.total}] ${msg.data.message}`, 'info');
        }
      };
    }
    connect();
    return () => wsRef.current?.close();
  }, [addLog]);

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto p-3 gap-3">
      <StatusBar accounts={status.accounts} activeViewers={status.activeViewers} />
      <AccountsPanel onLog={addLog} />
      <ViewersPanel onLog={addLog} />
      <LogPanel entries={logEntries} />
    </div>
  );
}
