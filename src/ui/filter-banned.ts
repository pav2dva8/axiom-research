import { accountManager } from './account-manager';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<void> {
  const delayMinMs = Math.max(0, envNumber('FILTER_DELAY_MIN_MS', 5000));
  const delayMaxMs = Math.max(delayMinMs, envNumber('FILTER_DELAY_MAX_MS', 10_000));
  const groupStartDelayMinMs = Math.max(0, envNumber('FILTER_GROUP_START_MIN_MS', 5000));
  const groupStartDelayMaxMs = Math.max(groupStartDelayMinMs, envNumber('FILTER_GROUP_START_MAX_MS', 15_000));

  const accounts = accountManager
    .listAccounts()
    .filter((account) => !account.banned && account.hasTokens)
    .map((account) => account.publicKey);

  if (accounts.length === 0) {
    console.log('[filter] No active accounts with refresh tokens.');
    return;
  }

  console.log(
    `[filter] Scanning ${accounts.length} account(s), refresh delay ${delayMinMs}-${delayMaxMs}ms, group start ${groupStartDelayMinMs}-${groupStartDelayMaxMs}ms.`,
  );

  const warm = await accountManager.warmProxySessionsForAccounts(
    accounts,
    { groupStartDelayMinMs, groupStartDelayMaxMs },
    (message) => console.log(`[filter] ${message}`),
  );
  if (!warm.ok) {
    throw new Error(warm.error ?? 'Could not warm proxy sessions.');
  }

  try {
    const result = await accountManager.refreshAccounts(
      accounts,
      (done, total, message) => console.log(`[filter] ${done}/${total} ${message}`),
      {
        force: true,
        continueOnBan: true,
        delayMinMs,
        delayMaxMs,
      },
    );
    console.log(
      `[filter] Done. refreshed=${result.success}/${result.total} banned=${result.bannedPublicKeys?.length ?? 0}`,
    );
    if (result.bannedPublicKeys?.length) {
      console.log(`[filter] Removed banned: ${result.bannedPublicKeys.join(', ')}`);
    }
  } finally {
    accountManager.stopKeepLoggedIn();
  }
}

main().catch((err: any) => {
  accountManager.stopKeepLoggedIn();
  console.error(`[filter] ${err?.stack || err?.message || String(err)}`);
  process.exit(1);
});
