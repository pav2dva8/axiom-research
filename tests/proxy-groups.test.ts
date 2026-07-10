import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  assignAccountsToProxyGroups,
  loadProxyFile,
  parseProxyLine,
} from "../src/proxy-groups";

test("parseProxyLine supports host:port:user:pass without leaking credentials in label", () => {
  const proxy = parseProxyLine("1.2.3.4:8080:alice:secret", 0);

  assert.deepEqual(proxy, {
    id: 1,
    label: "proxy 1",
    server: "http://1.2.3.4:8080",
    username: "alice",
    password: "secret",
  });
});

test("parseProxyLine supports URL proxy formats", () => {
  assert.deepEqual(parseProxyLine("socks5://bob:pw@example.com:9000", 4), {
    id: 5,
    label: "proxy 5",
    server: "socks5://example.com:9000",
    username: "bob",
    password: "pw",
  });
});

test("loadProxyFile skips comments and blank lines", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-proxies-"));
  const file = path.join(tmp, "proxies.txt");
  fs.writeFileSync(file, "\n# comment\n1.2.3.4:8080:u:p\n\nhttp://5.6.7.8:9000\n");

  try {
    const proxies = loadProxyFile(file);
    assert.equal(proxies.length, 2);
    assert.equal(proxies[0].server, "http://1.2.3.4:8080");
    assert.equal(proxies[1].server, "http://5.6.7.8:9000");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("assignAccountsToProxyGroups balances accounts across proxies", () => {
  const proxies = Array.from({ length: 16 }, (_, i) => ({
    id: i + 1,
    label: `proxy ${i + 1}`,
    server: `http://proxy-${i + 1}:8080`,
  }));
  const accounts = Array.from({ length: 58 }, (_, i) => `acct-${i + 1}`);

  const groups = assignAccountsToProxyGroups(accounts, proxies);

  assert.equal(groups.length, 16);
  assert.deepEqual(groups.map((g) => g.accounts.length), [
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3,
  ]);
  assert.deepEqual(groups[0].accounts, ["acct-1", "acct-2", "acct-3", "acct-4"]);
  assert.deepEqual(groups[15].accounts, ["acct-56", "acct-57", "acct-58"]);
});
