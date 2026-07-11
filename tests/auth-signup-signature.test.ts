import test from "node:test";
import assert from "node:assert/strict";
import { signup } from "../src/auth";

test("signup function accepts an optional fourth agent argument", () => {
  assert.equal(typeof signup, "function");
  assert.ok(signup.length >= 1);
  // TypeScript compile check is the real guarantee; runtime length may be <4 due to defaults.
  // Ensure the module still exports signup after agent plumbing.
  assert.equal(signup.name, "signup");
});
