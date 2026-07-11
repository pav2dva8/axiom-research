import { useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

export interface LogEntry {
  id: number;
  time: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface Props {
  entries: LogEntry[];
}

export function LogPanel({ entries }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries]);

  async function copyServerLog() {
    try {
      const res = await fetch('/api/logs/current');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { file?: string; content?: string };
      const text = [`# ${data.file ?? 'server log'}`, data.content || '(empty)'].join('\n');
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    } finally {
      window.setTimeout(() => setCopyState('idle'), 2000);
    }
  }

  return (
    <div className="border-t border-border bg-background">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Log
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" onClick={copyServerLog}>
            <Copy className="h-3.5 w-3.5" />
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Failed' : 'Server log'}
          </Button>
          <span className="text-xs text-muted-foreground">{entries.length}</span>
        </div>
      </div>
      <ScrollArea className="h-40 px-4 pb-2">
        <div className="space-y-0 font-mono text-xs leading-relaxed">
          {entries.length === 0 ? (
            <div className="text-muted-foreground">Idle.</div>
          ) : (
            entries.map((e) => (
              <div key={e.id} className="flex gap-3">
                <span className="shrink-0 text-muted-foreground/70">{e.time}</span>
                <span
                  className={cn(
                    'min-w-0 break-words',
                    e.type === 'success' && 'text-emerald-400',
                    e.type === 'error' && 'text-red-400',
                    e.type === 'info' && 'text-foreground',
                  )}
                >
                  {e.message}
                </span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
