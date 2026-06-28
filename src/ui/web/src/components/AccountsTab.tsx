import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, RefreshCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import type { LogEntry } from '@/components/LogPanel';

interface Account {
  publicKey: string;
  tokenValid: boolean;
  hasTokens: boolean;
  selected: boolean;
  lastUsed?: string;
}

interface Props {
  onLog: (msg: string, type: LogEntry['type']) => void;
  refreshTick: number;
  onChanged: () => void;
}

function shortKey(k: string) {
  return `${k.slice(0, 4)}\u2026${k.slice(-4)}`;
}

export function AccountsTab({ onLog, refreshTick, onChanged }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      setAccounts(Array.isArray(data) ? data : []);
    } catch (err: any) {
      onLog(`Failed to load accounts: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [onLog]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts, refreshTick]);

  // Light polling for token-validity changes during re-login
  useEffect(() => {
    const t = setInterval(fetchAccounts, 4000);
    return () => clearInterval(t);
  }, [fetchAccounts]);

  async function toggleSelected(publicKey: string, selected: boolean) {
    setAccounts((prev) => prev.map((a) => (a.publicKey === publicKey ? { ...a, selected } : a)));
    try {
      await fetch('/api/accounts/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey, selected }),
      });
      onChanged();
    } catch (err: any) {
      onLog(`Select failed: ${err.message}`, 'error');
      fetchAccounts();
    }
  }

  async function selectAll(value: boolean) {
    const targets = accounts.filter((a) => a.selected !== value);
    setAccounts((prev) => prev.map((a) => ({ ...a, selected: value })));
    await Promise.all(
      targets.map((a) =>
        fetch('/api/accounts/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: a.publicKey, selected: value }),
        }),
      ),
    );
    onChanged();
  }

  /** Set selection to exactly the accounts matching `predicate`. */
  async function selectByStatus(predicate: (a: Account) => boolean) {
    const changes = accounts
      .map((a) => ({ account: a, next: predicate(a) }))
      .filter(({ account, next }) => account.selected !== next);
    setAccounts((prev) => prev.map((a) => ({ ...a, selected: predicate(a) })));
    await Promise.all(
      changes.map(({ account, next }) =>
        fetch('/api/accounts/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: account.publicKey, selected: next }),
        }),
      ),
    );
    onChanged();
  }

  async function reloginRow(publicKey: string) {
    setPendingKey(publicKey);
    try {
      const res = await fetch('/api/accounts/relogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKeys: [publicKey] }),
      });
      const data = await res.json();
      onLog(
        data.success > 0
          ? `Re-logged in ${shortKey(publicKey)}`
          : `Re-login failed for ${shortKey(publicKey)}`,
        data.success > 0 ? 'success' : 'error',
      );
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    } finally {
      setPendingKey(null);
      fetchAccounts();
    }
  }

  async function reloginSelected() {
    setBulkRunning(true);
    onLog('Re-logging in selected accounts...', 'info');
    try {
      const selected = accounts.filter((a) => a.selected).map((a) => a.publicKey);
      const res = await fetch('/api/accounts/relogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKeys: selected }),
      });
      const data = await res.json();
      onLog(`Re-logged in ${data.success}/${data.total} accounts`, 'success');
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    } finally {
      setBulkRunning(false);
      fetchAccounts();
    }
  }

  async function refreshSelected() {
    setBulkRunning(true);
    onLog('Refreshing selected accounts...', 'info');
    try {
      const selected = accounts.filter((a) => a.selected).map((a) => a.publicKey);
      const res = await fetch('/api/accounts/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKeys: selected }),
      });
      const data = await res.json();
      onLog(`Refreshed ${data.success}/${data.total} accounts`, 'success');
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    } finally {
      setBulkRunning(false);
      fetchAccounts();
    }
  }

  async function stopRelogin() {
    await fetch('/api/accounts/relogin/stop', { method: 'POST' });
    onLog('Stopping re-login...', 'info');
    setBulkRunning(false);
  }

  function copyKey(k: string) {
    navigator.clipboard?.writeText(k).then(
      () => onLog('Public key copied', 'success'),
      () => onLog('Copy failed', 'error'),
    );
  }

  const selectedCount = accounts.filter((a) => a.selected).length;
  const allSelected = accounts.length > 0 && selectedCount === accounts.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const loggedInCount = accounts.filter((a) => a.tokenValid).length;
  const expiredCount = accounts.filter((a) => a.hasTokens && !a.tokenValid).length;
  const needsLoginCount = accounts.filter((a) => !a.tokenValid && !a.hasTokens).length;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">Accounts</span>
          <span className="text-xs text-muted-foreground">
            {selectedCount}/{accounts.length} selected
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => selectByStatus((a) => a.tokenValid)}
            disabled={loggedInCount === 0 || bulkRunning}
          >
            Logged in ({loggedInCount})
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => selectByStatus((a) => a.hasTokens && !a.tokenValid)}
            disabled={expiredCount === 0 || bulkRunning}
          >
            Expired ({expiredCount})
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => selectByStatus((a) => !a.tokenValid && !a.hasTokens)}
            disabled={needsLoginCount === 0 || bulkRunning}
          >
            Needs login ({needsLoginCount})
          </Button>
          {!bulkRunning ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={refreshSelected}
                disabled={selectedCount === 0}
                title="Use /refresh-access-token (fast, no Turnstile)"
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                Refresh selected
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={reloginSelected}
                disabled={selectedCount === 0}
                title="Full re-login: Turnstile + sign nonce + verify"
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                Re-login selected
              </Button>
            </>
          ) : (
            <Button size="sm" variant="destructive" onClick={stopRelogin}>
              <Square className="mr-2 h-3.5 w-3.5" />
              Stop
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  onCheckedChange={(v) => selectAll(v === true)}
                  aria-label="Select all"
                />
              </TableHead>
              <TableHead>Public key</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="w-16 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-xs text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-xs text-muted-foreground">
                  No accounts. Add base58 private keys to <span className="font-mono">keys.txt</span>{' '}
                  (one per line).
                </TableCell>
              </TableRow>
            ) : (
              accounts.map((a) => (
                <TableRow key={a.publicKey}>
                  <TableCell>
                    <Checkbox
                      checked={a.selected}
                      onCheckedChange={(v) => toggleSelected(a.publicKey, v === true)}
                      aria-label={`Select ${a.publicKey}`}
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => copyKey(a.publicKey)}
                      className="group inline-flex items-center gap-1.5 font-mono text-xs hover:text-primary"
                      title={a.publicKey}
                    >
                      {shortKey(a.publicKey)}
                      <Copy className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  </TableCell>
                  <TableCell>
                    {a.tokenValid ? (
                      <Badge variant="success">Logged in</Badge>
                    ) : a.hasTokens ? (
                      <Badge variant="secondary">Expired</Badge>
                    ) : (
                      <Badge variant="outline">Needs login</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.lastUsed ? new Date(a.lastUsed).toLocaleString() : '\u2014'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => reloginRow(a.publicKey)}
                      disabled={pendingKey !== null || bulkRunning}
                      aria-label="Re-login"
                    >
                      {pendingKey === a.publicKey ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Edit <span className="font-mono">keys.txt</span> in the project root to add or remove accounts.
        One base58 private key per line.
      </p>
    </div>
  );
}
