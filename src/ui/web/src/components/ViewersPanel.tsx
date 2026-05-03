import { useState } from 'react';
import { Play, Square, Eye } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface TokenInfo {
  ticker: string;
  name: string;
}

interface Props {
  onLog: (msg: string, type: 'success' | 'error' | 'info') => void;
}

export function ViewersPanel({ onLog }: Props) {
  const [pairAddress, setPairAddress] = useState('');
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [starting, setStarting] = useState(false);

  async function fetchTokenInfo(addr: string) {
    if (!addr) return;
    try {
      const res = await fetch(`/api/token-info?pairAddress=${addr}`);
      const data = await res.json();
      if (data.ticker) setTokenInfo({ ticker: data.ticker, name: data.name });
    } catch {}
  }

  async function startViewers() {
    if (!pairAddress) { onLog('Please enter a pair address', 'error'); return; }
    setStarting(true);
    try {
      const res = await fetch('/api/viewers/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairAddress }),
      });
      const data = await res.json();
      if (data.tokenInfo) setTokenInfo({ ticker: data.tokenInfo.ticker, name: data.tokenInfo.name });
      onLog(`Started ${data.connected} viewers on ${data.tokenInfo?.ticker ?? 'token'}`, 'success');
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    }
    setStarting(false);
  }

  async function stopViewers() {
    try {
      await fetch('/api/viewers/stop', { method: 'POST' });
      onLog('All viewers stopped', 'success');
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="h-3.5 w-3.5" /> Viewers
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder="Pair address from Axiom URL"
          value={pairAddress}
          onChange={(e) => setPairAddress(e.target.value)}
          onBlur={() => fetchTokenInfo(pairAddress)}
        />
        {tokenInfo && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-primary border-primary/40 font-mono">
              {tokenInfo.ticker}
            </Badge>
            <span className="text-xs text-muted-foreground">{tokenInfo.name}</span>
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={startViewers} disabled={starting} className="flex-1">
            <Play className="h-3.5 w-3.5 mr-1.5" /> Start
          </Button>
          <Button variant="destructive" onClick={stopViewers} className="flex-1">
            <Square className="h-3.5 w-3.5 mr-1.5" /> Stop
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
