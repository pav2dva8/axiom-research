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
