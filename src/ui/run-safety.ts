export interface RunSafetyAccount {
  publicKey: string;
}

export interface RunSafetyGroup<T extends RunSafetyAccount> {
  accounts: T[];
}

export interface RunSafetyResult<T extends RunSafetyAccount> {
  accounts: T[];
  selectedTotal: number;
  limited: boolean;
  maxAccounts: number;
}

export function normalizeSafetyMaxAccounts(value: unknown, fallback = 2): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

export function limitAccountsForRun<T extends RunSafetyAccount>(
  accounts: T[],
  maxAccounts?: number,
  groups?: Array<RunSafetyGroup<T>>,
): RunSafetyResult<T> {
  const selectedTotal = accounts.length;
  const max = Math.max(0, Math.floor(maxAccounts ?? 0));
  if (max === 0 || accounts.length <= max) {
    return { accounts, selectedTotal, limited: false, maxAccounts: max };
  }

  const byPublicKey = new Map(accounts.map((account) => [account.publicKey, account]));
  const limited: T[] = [];
  const seen = new Set<string>();

  if (groups && groups.length > 0) {
    const groupAccounts = groups
      .map((group) => group.accounts.map((account) => byPublicKey.get(account.publicKey)).filter((account): account is T => !!account));
    const maxGroupLength = Math.max(0, ...groupAccounts.map((items) => items.length));
    for (let index = 0; index < maxGroupLength && limited.length < max; index++) {
      for (const items of groupAccounts) {
        const account = items[index];
        if (!account || seen.has(account.publicKey)) continue;
        limited.push(account);
        seen.add(account.publicKey);
        if (limited.length >= max) break;
      }
    }
  }

  for (const account of accounts) {
    if (limited.length >= max) break;
    if (seen.has(account.publicKey)) continue;
    limited.push(account);
    seen.add(account.publicKey);
  }

  return { accounts: limited, selectedTotal, limited: true, maxAccounts: max };
}
