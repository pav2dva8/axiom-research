import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, RefreshCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
  banned?: boolean;
  banReason?: string;
  bannedAt?: string;
  lastUsed?: string;
  accessExpiresAt?: number;
}

interface Props {
  onLog: (msg: string, type: LogEntry['type']) => void;
  refreshTick: number;
  onChanged: () => void;
  keepWarmRunning: boolean;
}

function shortKey(k: string) {
  return `${k.slice(0, 4)}\u2026${k.slice(-4)}`;
}

/** Live mm:ss countdown to access-token expiry, with a colour class. */
function countdown(expiresAt: number | undefined, now: number): { text: string; cls: string } {
  if (expiresAt == null) return { text: '\u2014', cls: 'text-muted-foreground' };
  const ms = expiresAt - now;
  if (ms <= 0) return { text: 'expired', cls: 'text-red-400' };
  const totalSec = Math.floor(ms / 1000);
  const text = `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
  return { text, cls: ms <= 5 * 60_000 ? 'text-amber-400' : 'text-emerald-400' };
}

export function AccountsTab({ onLog, refreshTick, onChanged, keepWarmRunning }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [keepWarmSettings, setKeepWarmSettings] = useState({
    groupStartMinSec: 5,
    groupStartMaxSec: 15,
    refreshDelayMinSec: 5,
    refreshDelayMaxSec: 10,
    refreshAgeMinMin: 2,
    refreshAgeMaxMin: 6,
  });

  // Tick once a second so the expiry countdowns stay live between 4s polls.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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

  function updateKeepWarmSetting(key: keyof typeof keepWarmSettings, value: string) {
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    setKeepWarmSettings((prev) => ({ ...prev, [key]: next }));
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
    onLog('Refreshing due selected accounts...', 'info');
    try {
      const selected = accounts.filter((a) => a.selected).map((a) => a.publicKey);
      const res = await fetch('/api/accounts/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKeys: selected }),
      });
      const data = await res.json();
      const skippedFresh = Number(data.skippedFresh ?? 0);
      onLog(
        skippedFresh > 0
          ? `Refreshed ${data.success}/${data.total} accounts; skipped ${skippedFresh} fresh`
          : `Refreshed ${data.success}/${data.total} accounts`,
        data.success > 0 || skippedFresh > 0 ? 'success' : 'info',
      );
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    } finally {
      setBulkRunning(false);
      fetchAccounts();
    }
  }

  async function startKeepWarm() {
    const selected = accounts.filter((a) => a.selected).map((a) => a.publicKey);
    if (selected.length === 0) {
      onLog('Select accounts first', 'error');
      return;
    }
    onLog(
      `Keeping ${selected.length} account(s) logged in (groups ${keepWarmSettings.groupStartMinSec}-${keepWarmSettings.groupStartMaxSec}s, gap ${keepWarmSettings.refreshDelayMinSec}-${keepWarmSettings.refreshDelayMaxSec}s, refresh ${keepWarmSettings.refreshAgeMinMin}-${keepWarmSettings.refreshAgeMaxMin}m)...`,
      'info',
    );
    try {
      await fetch('/api/accounts/keepwarm/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKeys: selected,
          groupStartDelayMinMs: keepWarmSettings.groupStartMinSec * 1000,
          groupStartDelayMaxMs: keepWarmSettings.groupStartMaxSec * 1000,
          refreshDelayMinMs: keepWarmSettings.refreshDelayMinSec * 1000,
          refreshDelayMaxMs: keepWarmSettings.refreshDelayMaxSec * 1000,
          refreshThresholdMinMin: keepWarmSettings.refreshAgeMinMin,
          refreshThresholdMaxMin: keepWarmSettings.refreshAgeMaxMin,
        }),
      });
    } catch (err: any) {
      onLog(`Keep-logged-in failed: ${err.message}`, 'error');
    }
  }

  async function stopKeepWarm() {
    try {
      await fetch('/api/accounts/keepwarm/stop', { method: 'POST' });
    } catch (err: any) {
      onLog(`Error: ${err.message}`, 'error');
    }
  }

  async function stopRelogin() {
    await fetch('/api/accounts/relogin/stop', { method: 'POST' });
    onLog('Stopping...', 'info');
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
  const bannedCount = accounts.filter((a) => a.banned).length;
  const loggedInCount = accounts.filter((a) => a.tokenValid && !a.banned).length;
  const needsRefreshCount = accounts.filter((a) => a.hasTokens && !a.tokenValid && !a.banned).length;
  const needsLoginCount = accounts.filter((a) => !a.tokenValid && !a.hasTokens && !a.banned).length;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">Accounts</span>
              <span className="text-xs text-muted-foreground">
                {selectedCount}/{accounts.length} selected
              </span>
              {bannedCount > 0 && (
                <span className="text-xs text-red-400">{bannedCount} banned</span>
              )}
            {keepWarmRunning && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                keeping logged in
              </span>
            )}
          </div>
          {keepWarmRunning ? (
            <Button size="sm" variant="destructive" onClick={stopKeepWarm}>
              <Square className="mr-2 h-3.5 w-3.5" />
              Stop keeping logged in
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={startKeepWarm}
              disabled={selectedCount === 0 || bulkRunning}
              title="Refresh selected accounts when they enter the configured refresh-age window, then keep them logged in indefinitely. Uses proxies.txt automatically when present."
            >
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Keep logged in ({selectedCount})
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
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
              onClick={() => selectByStatus((a) => a.hasTokens && !a.tokenValid && !a.banned)}
              disabled={needsRefreshCount === 0 || bulkRunning}
            >
              Needs refresh ({needsRefreshCount})
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => selectByStatus((a) => !a.tokenValid && !a.hasTokens && !a.banned)}
              disabled={needsLoginCount === 0 || bulkRunning}
            >
              Needs login ({needsLoginCount})
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!bulkRunning ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={refreshSelected}
                  disabled={selectedCount === 0 || keepWarmRunning}
                  title="One-off refresh of selected accounts that are due or within 3 minutes of expiry (no Turnstile), paced 2.5-3.5s apart. Disabled while keep-warm is running."
                >
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Refresh selected
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={reloginSelected}
                  disabled={selectedCount === 0 || keepWarmRunning}
                  title="Full re-login: Turnstile + sign nonce + verify. Disabled while keep-logged-in is running (use the per-row button for a single dead account)."
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
        <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-muted-foreground">
            <span>Group start (s)</span>
            <span className="flex items-center gap-1.5">
              <Input
                type="number"
                min={0}
                step={1}
                value={keepWarmSettings.groupStartMinSec}
                disabled={keepWarmRunning || bulkRunning}
                onChange={(event) => updateKeepWarmSetting('groupStartMinSec', event.target.value)}
                className="h-8"
              />
              <span>-</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={keepWarmSettings.groupStartMaxSec}
                disabled={keepWarmRunning || bulkRunning}
                onChange={(event) => updateKeepWarmSetting('groupStartMaxSec', event.target.value)}
                className="h-8"
              />
            </span>
          </label>
          <label className="flex flex-col gap-1 text-muted-foreground">
            <span>Group gap (s)</span>
            <span className="flex items-center gap-1.5">
              <Input
                type="number"
                min={0.5}
                step={0.5}
                value={keepWarmSettings.refreshDelayMinSec}
                disabled={keepWarmRunning || bulkRunning}
                onChange={(event) => updateKeepWarmSetting('refreshDelayMinSec', event.target.value)}
                className="h-8"
              />
              <span>-</span>
              <Input
                type="number"
                min={0.5}
                step={0.5}
                value={keepWarmSettings.refreshDelayMaxSec}
                disabled={keepWarmRunning || bulkRunning}
                onChange={(event) => updateKeepWarmSetting('refreshDelayMaxSec', event.target.value)}
                className="h-8"
              />
            </span>
          </label>
          <label className="flex flex-col gap-1 text-muted-foreground">
            <span>Refresh at (m)</span>
            <span className="flex items-center gap-1.5">
              <Input
                type="number"
                min={1}
                step={1}
                value={keepWarmSettings.refreshAgeMinMin}
                disabled={keepWarmRunning || bulkRunning}
                onChange={(event) => updateKeepWarmSetting('refreshAgeMinMin', event.target.value)}
                className="h-8"
              />
              <span>-</span>
              <Input
                type="number"
                min={1}
                step={1}
                value={keepWarmSettings.refreshAgeMaxMin}
                disabled={keepWarmRunning || bulkRunning}
                onChange={(event) => updateKeepWarmSetting('refreshAgeMaxMin', event.target.value)}
                className="h-8"
              />
            </span>
          </label>
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
                    <div className="flex items-center gap-2">
                      {a.banned ? (
                        <Badge variant="destructive">Banned</Badge>
                      ) : a.tokenValid ? (
                        <Badge variant="success">Logged in</Badge>
                      ) : a.hasTokens ? (
                        <Badge variant="secondary">Needs refresh</Badge>
                      ) : (
                        <Badge variant="outline">Needs login</Badge>
                      )}
                      {a.tokenValid && a.accessExpiresAt != null && (() => {
                        const c = countdown(a.accessExpiresAt, now);
                        return <span className={`font-mono text-xs ${c.cls}`}>{c.text}</span>;
                      })()}
                    </div>
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
