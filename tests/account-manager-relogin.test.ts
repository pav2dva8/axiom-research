import test from "node:test";
import assert from "node:assert/strict";

import { isBanSignalMessage, reloginFailureBackoffMs } from "../src/ui/account-manager";

test("re-login backs off after verify Weird Error failures", () => {
  assert.equal(
    reloginFailureBackoffMs('Verify failed on api7.axiom.trade: 500 - {"error":"Weird Error!"}'),
    15_000,
  );
  assert.equal(reloginFailureBackoffMs("Turnstile timeout (30s)"), 0);
});

test("Weird Error is treated as a ban signal", () => {
  assert.equal(
    isBanSignalMessage('Verify failed on api7.axiom.trade: 500 - {"error":"Weird Error!"}'),
    true,
  );
  assert.equal(isBanSignalMessage("friends closed code=1006"), false);
});
