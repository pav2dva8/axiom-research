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
# Task 5 Report: RegisterTab UI + App wiring

## Status

Complete.

## Changes

- Added `RegisterTab` with defaults loading from `GET /api/register/defaults`.
- Added start/stop actions for `POST /api/register/start` and `POST /api/register/stop`.
- Displayed output file, proxy count, and succeeded/failed counters.
- Added the `Register` tab in `App.tsx`.
- Wired `register-started`, `register-progress`, and `register-finished` WebSocket events into logs, `registerRunning`, and progress state.
- Synchronized `registerRunning` from status payloads when present.

## Verification

- `npm run build:web` passed.
- `ReadLints` reported no linter errors for `App.tsx` or `RegisterTab.tsx`.

## Commit

- `929e4b0 feat(register): add Register tab for fresh account signup`

## Self-review

- Checked the committed diff for scope and behavior.
- Confirmed the commit includes only `src/ui/web/src/App.tsx` and `src/ui/web/src/components/RegisterTab.tsx`.
- Existing unrelated `INVESTIGATION_REPORT.md` was left untouched.

## Concerns

- `npm run build:web` emitted the existing Vite/PostCSS module-type warning, but exited successfully.

## Review fix (amount-per-IP clamp)

- Added `clampAmountPerIp()` helper to enforce 1–3 range.
- Applied clamp on input `onChange`, defaults load, and `POST /api/register/start` body.
- `npm run build:web` passed (exit 0, built in 605ms; same Vite/PostCSS module-type warning).

## Commit (review fix)

- `002b67f fix(register): clamp accounts-per-IP to 1–3`
