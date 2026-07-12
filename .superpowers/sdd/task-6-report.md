### Task 6 Report: SessionDirector in ViewerService + Keep-Warm Hook

Status: complete.

Implemented:
- Added `ViewerService.startWarmupForGroups()` and `stopWarmup()` backed by `SessionActor` and `FeedPool`.
- Routed warmed proxy/direct keep-warm sessions from `AccountManager` into the viewer warmup director.
- Changed warmed deploys to use `actor.gotoDeploy()`, slow stop to use `actor.returnToWarmup()`, and force stop to close actor sessions.
- Broadcast `viewer-progress` with `state: "warmup"`.
- Extended `/api/viewers/stop` slow mode to accept `minGapMs` and `maxGapMs` while preserving `delayMs`.
- Added `tests/viewer-service-warmup.test.ts` with BrowserSession stubs only.

Verification:
- RED: `node --import tsx --test tests/viewer-service-warmup.test.ts` failed with `service.startWarmupForGroups is not a function`.
- GREEN: `node --import tsx --test tests/viewer-service-warmup.test.ts tests/viewer-service-groups.test.ts tests/account-manager-keepwarm-proxy.test.ts` passed 8/8.
- Build: `npm run build` passed.
- Final focused verification: `node --import tsx --test tests/viewer-service-warmup.test.ts tests/viewer-service-groups.test.ts tests/account-manager-keepwarm-proxy.test.ts && npm run build` passed.

Concerns:
- Existing dirty-tree changes remain in several files and were intentionally excluded from the Task 6 commit.
