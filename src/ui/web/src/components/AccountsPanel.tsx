import { useState } from 'react';
import { RefreshCw, Square, Users } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Props {
  onLog: (msg: string, type: 'success' | 'error' | 'info') => void;
}

export function AccountsPanel({ onLog }: Props) {
  const [relogging, setRelogging] = useState(false);

  async function reloginAll() {
    setRelogging(true);
    onLog('Re-logging in all accounts...', 'info');
    try {
      const res = await fetch('/api/accounts/relogin', { method: 'POST' });
      const data = await res.json();
      onLog(`Re-logged in ${data.success}/${data.total} accounts`, 'success');
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    }
    setRelogging(false);
  }

  async function stopRelogin() {
    await fetch('/api/accounts/relogin/stop', { method: 'POST' });
    onLog('Stopping re-login...', 'info');
    setRelogging(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5" /> Accounts
        </CardTitle>
      </CardHeader>
      <CardContent className="flex gap-2">
        {!relogging ? (
          <Button variant="secondary" size="sm" onClick={reloginAll}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Re-login All
          </Button>
        ) : (
          <Button variant="destructive" size="sm" onClick={stopRelogin}>
            <Square className="h-3.5 w-3.5 mr-1.5" /> Stop
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
