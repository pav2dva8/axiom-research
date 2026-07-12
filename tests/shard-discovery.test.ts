import test from "node:test";
import assert from "node:assert/strict";

import {
  API_SHARD_PROBE_HOSTS,
  AXIOM_BROWSER_PAGE_URL,
  AXIOM_SHARD_DISCOVERY_FALLBACK_URL,
  AXIOM_SHARD_DISCOVERY_URL,
  DEFAULT_CLUSTER_WS_URL,
  apiHostsForLoginOrRefresh,
  buildAuthCookieDomains,
  chooseDiscoveredApiHost,
  clusterHostFromWsUrl,
  normalizeClusterWsUrl,
  parseAxiomApiHost,
  parseAxiomClusterWsUrl,
  preferApiHosts,
} from "../src/browser-auth";

test("discovery URLs: terms is primary; portfolio/discover are fallbacks", () => {
  assert.equal(AXIOM_BROWSER_PAGE_URL, "https://axiom.trade/terms?chain=sol");
  assert.equal(AXIOM_SHARD_DISCOVERY_URL, "https://axiom.trade/portfolio?chain=sol");
  assert.equal(AXIOM_SHARD_DISCOVERY_FALLBACK_URL, "https://axiom.trade/discover?chain=sol");
});

test("parseAxiomApiHost accepts numbered api shards only", () => {
  assert.equal(parseAxiomApiHost("https://api9.axiom.trade/user-data?v=1"), "api9.axiom.trade");
  assert.equal(parseAxiomApiHost("https://api3.axiom.trade/refresh-access-token"), "api3.axiom.trade");
  assert.equal(parseAxiomApiHost("https://api.axiom.trade/wo/server-time"), null);
  assert.equal(parseAxiomApiHost("https://api2-bnb.axiom.trade/tracked-wallets-v2"), null);
  assert.equal(parseAxiomApiHost("https://friends.axiom.trade/ws"), null);
});

test("parseAxiomClusterWsUrl accepts numbered cluster sockets only", () => {
  assert.equal(
    parseAxiomClusterWsUrl("wss://cluster8.axiom.trade/"),
    "wss://cluster8.axiom.trade/",
  );
  assert.equal(
    parseAxiomClusterWsUrl("wss://cluster0.axiom.trade"),
    "wss://cluster0.axiom.trade/",
  );
  assert.equal(parseAxiomClusterWsUrl("wss://cluster-global1-heavy.axiom.trade/"), null);
  assert.equal(parseAxiomClusterWsUrl("wss://friends.axiom.trade/ws"), null);
  assert.equal(parseAxiomClusterWsUrl("wss://pulse2.axiom.trade/ws"), null);
});

test("normalizeClusterWsUrl and clusterHostFromWsUrl", () => {
  assert.equal(normalizeClusterWsUrl("wss://cluster5.axiom.trade"), "wss://cluster5.axiom.trade/");
  assert.equal(normalizeClusterWsUrl("wss://cluster5.axiom.trade/"), "wss://cluster5.axiom.trade/");
  assert.equal(clusterHostFromWsUrl("wss://cluster5.axiom.trade/"), "cluster5.axiom.trade");
  assert.equal(clusterHostFromWsUrl("not-a-url"), null);
});

test("preferApiHosts puts discovered host first without duplicates", () => {
  assert.deepEqual(
    preferApiHosts("api8.axiom.trade", [...API_SHARD_PROBE_HOSTS]),
    ["api8.axiom.trade", ...API_SHARD_PROBE_HOSTS.filter((h) => h !== "api8.axiom.trade")],
  );
  assert.deepEqual(
    preferApiHosts("api3.axiom.trade", [...API_SHARD_PROBE_HOSTS]),
    ["api3.axiom.trade", ...API_SHARD_PROBE_HOSTS.filter((h) => h !== "api3.axiom.trade")],
  );
  assert.deepEqual(
    preferApiHosts(null, [...API_SHARD_PROBE_HOSTS]),
    [...API_SHARD_PROBE_HOSTS],
  );
});

test("apiHostsForLoginOrRefresh and chooseDiscoveredApiHost", () => {
  assert.deepEqual(
    apiHostsForLoginOrRefresh("api4.axiom.trade"),
    preferApiHosts("api4.axiom.trade", API_SHARD_PROBE_HOSTS),
  );
  assert.equal(chooseDiscoveredApiHost(["api6.axiom.trade", "api7.axiom.trade"], () => 0), "api6.axiom.trade");
});

test("buildAuthCookieDomains includes discovered cluster host", () => {
  assert.deepEqual(
    buildAuthCookieDomains("wss://cluster4.axiom.trade/"),
    ["cluster4.axiom.trade", "friends.axiom.trade", ".axiom.trade"],
  );
  assert.deepEqual(
    buildAuthCookieDomains(null),
    [clusterHostFromWsUrl(DEFAULT_CLUSTER_WS_URL)!, "friends.axiom.trade", ".axiom.trade"],
  );
});
