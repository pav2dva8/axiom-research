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

### Review Finding Fix: connectAll actor deploy path

Status: complete.

Implemented:
- Changed direct `ViewerService.connectAll()` deploys to call the same actor-aware `deployAccount()` path used by `connectGroups()`.
- Skipped legacy cluster priming for managed browser sessions so warmed direct sessions are not sent through `connectViewer()`.
- Added a regression test for `startWarmupForGroups()` followed by direct-session `connectAll()` that asserts deploy navigation is used and legacy `connectViewer()` is not called.

Verification:
- RED: `node --test --import tsx tests/viewer-service-warmup.test.ts` failed with `0 !== 1` after legacy `connectViewer` was attempted.
- GREEN: `node --test --import tsx tests/viewer-service-warmup.test.ts` passed 2/2.
- Requested warmup suite: `node --test --import tsx tests/viewer-service-warmup.test.ts` passed 2/2.
- Build: `npm run build` passed.

Commit:
- `3fe4b70 fix: route direct viewer connects through warmup actors`

### Residual Fix: reuse keep-warm browser in ensureBrowserSession

Status: complete.

Implemented:
- Before opening a new browser in `ensureBrowserSession`, reuse `accountManager.getBrowserSession()` when present (direct keep-warm already opened Chrome), set it on `viewerService`, and return it.

Verification:
- Build: `npm run build` passed.
