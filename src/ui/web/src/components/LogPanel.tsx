import { useEffect, useRef } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Terminal } from 'lucide-react';

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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <Card className="flex flex-col flex-1 min-h-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5" /> Log
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 pt-0">
        <ScrollArea className="h-full rounded-md border border-border bg-input p-2">
          <div className="space-y-0.5 font-mono text-xs">
            {entries.map((e) => (
              <div key={e.id} className="flex gap-2 py-0.5 border-b border-border/40">
                <span className="text-muted-foreground shrink-0">{e.time}</span>
                <span className={cn(
                  e.type === 'success' && 'text-emerald-400',
                  e.type === 'error' && 'text-destructive',
                  e.type === 'info' && 'text-primary',
                )}>
                  {e.message}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
