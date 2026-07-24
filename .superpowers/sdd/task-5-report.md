Status: Implemented Task 5 SessionActor + warmup timing with TDD.

Files:
- `src/session/warmup-timing.ts`
- `src/session/session-actor.ts`
- `tests/session-actor.test.ts`

TDD:
- Red: `npx tsx --test tests/session-actor.test.ts` failed because `src/session/session-actor` was missing.
- Green: focused actor tests pass after implementing `WarmupTiming` and `SessionActor`.

Verification:
- `npx tsx --test tests/session-actor.test.ts`
- `npx tsx --test tests/session-actor.test.ts tests/token-navigation-plan.test.ts tests/page-update.test.ts tests/feed-pool.test.ts tests/run-nav-plan.test.ts`
- `npx tsc --noEmit`
- Cursor diagnostics: no linter errors for new/edited task files.

Concerns:
- `SessionBridge.openSession` is intentionally variadic because the brief did not lock the bridge argument shape.
- Warmup waits are not force-aborted; deploy/close cancel future warmup work and wait only for in-flight navigation.

## Review fix: openSession signature (Critical)

Status: Fixed.

Bug: `SessionActor.startWarmup` called `this.bridge.openSession(this.publicKey, access, refresh, openOpts)`, but `BrowserSession.openSession` expects `(accessToken, refreshToken, opts?)`.

Fix:
- `SessionBridge.openSession(access: string, refresh: string, opts?: unknown): Promise<number>`
- `startWarmup` now calls `this.bridge.openSession(access as string, refresh as string, openOpts)`
- Tests assert `openSession` receives `(access, refresh, opts)` without `publicKey`

Commit: `d9bbeec` — fix: pass access/refresh tokens to SessionBridge.openSession

Test summary (`npx tsx --test tests/session-actor.test.ts`):
- 3 tests, 3 pass, 0 fail
- gotoDeploy cancels warmup and navigates to deploy token — ok
- returnToWarmup leaves deploy and resumes warmup mode — ok
- forceClose closes session — ok

