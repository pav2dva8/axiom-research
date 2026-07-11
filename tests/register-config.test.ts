import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REGISTER_AMOUNT_PER_IP,
  DEFAULT_REGISTER_DELAY_SEC,
  freshKeysFilename,
  normalizeRegisterOptions,
  proxyConfigToAgentUrl,
} from "../src/ui/register-config";

test("normalizeRegisterOptions clamps amount and delay", () => {
  assert.deepEqual(normalizeRegisterOptions({}), {
    amountPerIp: DEFAULT_REGISTER_AMOUNT_PER_IP,
    delaySec: DEFAULT_REGISTER_DELAY_SEC,
    useProxies: false,
  });

  assert.equal(normalizeRegisterOptions({ amountPerIp: 0 }).amountPerIp, 1);
  assert.equal(normalizeRegisterOptions({ amountPerIp: 99 }).amountPerIp, 3);
  assert.equal(normalizeRegisterOptions({ amountPerIp: 2.9 }).amountPerIp, 2);
  assert.equal(normalizeRegisterOptions({ delaySec: -1 }).delaySec, 0);
  assert.equal(normalizeRegisterOptions({ delaySec: "7" }).delaySec, 7);
  assert.equal(normalizeRegisterOptions({ useProxies: true }).useProxies, true);
  assert.equal(normalizeRegisterOptions({ useProxies: "yes" }).useProxies, false);
});

test("freshKeysFilename uses local YYYY-MM-DD", () => {
  const d = new Date(2026, 6, 11, 23, 0, 0); // Jul 11 2026 local
  assert.equal(freshKeysFilename(d), "2026-07-11_fresh_keys.txt");
});

test("proxyConfigToAgentUrl embeds credentials when present", () => {
  assert.equal(
    proxyConfigToAgentUrl({ server: "http://1.2.3.4:8080", username: "u", password: "p" }),
    "http://u:p@1.2.3.4:8080",
  );
  assert.equal(
    proxyConfigToAgentUrl({ server: "http://1.2.3.4:8080" }),
    "http://1.2.3.4:8080",
  );
});
