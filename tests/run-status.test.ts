import test from "node:test";
import assert from "node:assert/strict";

import {
  accountRunStatus,
  VIEWER_STATUS_META,
  type AccountAuthStatus,
  type RunViewerState,
} from "../src/ui/web/src/lib/run-status";

test("live viewer state overrides account auth status in run chips", () => {
  const status = accountRunStatus("expired", "connecting");

  assert.equal(status.label, "connecting");
  assert.match(status.className, /sky/);
  assert.equal(status.title, "connecting");
});

test("account auth status is used before a viewer state exists", () => {
  const loggedIn = accountRunStatus("loggedIn");
  const expired = accountRunStatus("expired");
  const needsLogin = accountRunStatus("needsLogin");

  assert.equal(loggedIn.label, "ok");
  assert.match(loggedIn.className, /emerald/);
  assert.equal(expired.label, "exp");
  assert.match(expired.className, /amber/);
  assert.equal(needsLogin.label, "login");
  assert.match(needsLogin.className, /red/);
});

test("every live viewer state has a visible status label and color", () => {
  const states: RunViewerState[] = ["pending", "connecting", "connected", "failed", "disconnected"];
  const auth: AccountAuthStatus = "loggedIn";

  for (const state of states) {
    const status = accountRunStatus(auth, state);
    assert.equal(status.label, VIEWER_STATUS_META[state].label);
    assert.ok(status.className.length > 0);
    assert.notEqual(status.className, accountRunStatus(auth).className);
  }
});
