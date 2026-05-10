import { useState } from 'react';
import { Loader2, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type { LogEntry } from '@/components/LogPanel';

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

interface Props {
  onLog: (msg: string, type: LogEntry['type']) => void;
}

/**
 * Heuristic: pump.fun token CAs always end with "pump"; pair addresses don't.
 * If the user pasted something we can't classify, we treat it as a pair address
 * and let the server validate.
 */
function isLikelyCA(input: string): boolean {
  return /pump$/i.test(input.trim());
}

export function RunTab({ onLog }: Props) {
  const [input, setInput] = useState('');
  const [token, setToken] = useState<ResolvedToken | null>(null);
  const [resolving, setResolving] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  async function resolveAndStart() {
    const trimmed = input.trim();
    if (!trimmed) {
      onLog('Enter a token CA or pair address', 'error');
      return;
    }

    setBusy(true);
    setResolving(true);
    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: trimmed }),
      });
      const data = await res.json();
      if (!res.ok || !data.tokenInfo) {
        onLog(`Resolve failed: ${data.error ?? res.statusText}`, 'error');
        setBusy(false);
        setResolving(false);
        return;
      }
      const t = data.tokenInfo as ResolvedToken;
      setToken(t);
      setResolving(false);
      onLog(
        `Resolved ${isLikelyCA(trimmed) ? 'CA' : 'pair'} to ${t.ticker} (${t.pairAddress.slice(0, 6)}\u2026)`,
        'success',
      );

      const startRes = await fetch('/api/viewers/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairAddress: t.pairAddress }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) {
        onLog(`Start failed: ${startData.error ?? startRes.statusText}`, 'error');
        setBusy(false);
        return;
      }
      onLog(`Started ${startData.connected} viewer(s) on ${t.ticker}`, 'success');
      setRunning(true);
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
      setResolving(false);
    } finally {
      setBusy(false);
    }
  }

  async function stopViewers() {
    setBusy(true);
    try {
      await fetch('/api/viewers/stop', { method: 'POST' });
      onLog('Viewers stopped', 'success');
      setRunning(false);
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
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
            placeholder="2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump"
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            disabled={running || busy}
          />
          {!running ? (
            <Button onClick={resolveAndStart} disabled={busy || !input.trim()}>
              {resolving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              <span className="ml-2">Start</span>
            </Button>
          ) : (
            <Button variant="destructive" onClick={stopViewers} disabled={busy}>
              <Square className="h-4 w-4" />
              <span className="ml-2">Stop</span>
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Paste a pump.fun CA (ends with <span className="font-mono">pump</span>) or an Axiom pair address. CA is resolved to pair under the hood.
        </p>
      </div>

      {token && (
        <div className="rounded-md border border-border bg-card p-3">
          <div className="flex items-baseline gap-2">
            <Badge variant="outline" className="font-mono">
              {token.ticker}
            </Badge>
            <span className="text-sm">{token.name}</span>
            {token.isMigrated && (
              <Badge variant="secondary" className="text-[10px]">
                migrated
              </Badge>
            )}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
            <dt className="text-muted-foreground">pair</dt>
            <dd className="truncate">{token.pairAddress}</dd>
            <dt className="text-muted-foreground">token</dt>
            <dd className="truncate">{token.tokenAddress || '\u2014'}</dd>
            <dt className="text-muted-foreground">protocol</dt>
            <dd>{token.protocol}</dd>
            <dt className="text-muted-foreground">price</dt>
            <dd>{token.price ? token.price.toExponential(3) : '\u2014'}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
