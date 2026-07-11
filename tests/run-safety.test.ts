import test from "node:test";
import assert from "node:assert/strict";

import { limitAccountsForRun } from "../src/ui/run-safety";

const account = (publicKey: string) => ({ publicKey });

test("limitAccountsForRun keeps all accounts when cap is disabled", () => {
  const accounts = [account("a"), account("b"), account("c")];

  assert.deepEqual(limitAccountsForRun(accounts, 0).accounts, accounts);
  assert.deepEqual(limitAccountsForRun(accounts, undefined).accounts, accounts);
});

test("limitAccountsForRun caps direct runs in input order", () => {
  const accounts = [account("a"), account("b"), account("c")];

  const result = limitAccountsForRun(accounts, 2);

  assert.equal(result.limited, true);
  assert.equal(result.selectedTotal, 3);
  assert.deepEqual(result.accounts.map((item) => item.publicKey), ["a", "b"]);
});

test("limitAccountsForRun caps proxy runs round-robin across groups", () => {
  const accounts = ["a1", "a2", "b1", "b2", "c1", "c2"].map(account);

  const result = limitAccountsForRun(accounts, 4, [
    { accounts: [account("a1"), account("a2")] },
    { accounts: [account("b1"), account("b2")] },
    { accounts: [account("c1"), account("c2")] },
  ]);

  assert.deepEqual(result.accounts.map((item) => item.publicKey), ["a1", "b1", "c1", "a2"]);
});
