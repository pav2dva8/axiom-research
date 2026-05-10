import { useEffect, useRef } from 'react';
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries]);

  return (
    <div className="border-t border-border bg-background">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Log
        </span>
        <span className="text-xs text-muted-foreground">{entries.length}</span>
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
