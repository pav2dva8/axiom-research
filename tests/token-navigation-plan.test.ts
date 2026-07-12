import test from "node:test";
import assert from "node:assert/strict";
import {
  planEnterFromFeed,
  planTokenToToken,
  planLeaveAll,
} from "../src/session/token-navigation-plan";

const T = { pairAddress: "Pair111", tokenAddress: "Token111" };
const U = { pairAddress: "Pair222", tokenAddress: "Token222" };
const fixed = () => 0; // min delays

test("planEnterFromFeed stages early then late joins and meme pageUpdate", () => {
  const plan = planEnterFromFeed(T, fixed);
  const roomsAt0 = plan.filter((a) => a.atMs === 0 && a.op === "join").map((a) => a.room);
  assert.deepEqual(roomsAt0.sort(), ["Pair111_refresh", "f:Pair111", "t:Pair111"].sort());
  const late = plan.filter((a) => a.atMs >= 450 && a.op === "join").map((a) => a.room!);
  for (const need of [
    "e-Pair111", "td:Pair111", "s:Pair111", "Pair111-dex-paid",
    "Pair111-wallet_funding", "kol_tx:Pair111", "pump-cto:Pair111",
    "a:Token111", "soc_bub:Token111",
  ]) {
    assert.equal(late.includes(need), true, `missing ${need}`);
  }
  assert.equal(late.includes("b-Pair111"), true);
  const pu = plan.find((a) => a.op === "pageUpdate");
  assert.ok(pu && pu.atMs >= 450 && pu.ws === "friends");
});

test("planTokenToToken leaves prev before joining next and delays e- leave", () => {
  const plan = planTokenToToken(T, U, fixed);
  const firstJoin = Math.min(...plan.filter((a) => a.op === "join").map((a) => a.atMs));
  const leaves = plan.filter((a) => a.op === "leave");
  assert.ok(leaves.every((a) => a.atMs < firstJoin || a.room === "e-Pair111"));
  const eLeave = leaves.find((a) => a.room === "e-Pair111");
  assert.ok(eLeave && eLeave.atMs >= firstJoin + 36);
});

test("planLeaveAll leaves token rooms including e-", () => {
  const rooms = planLeaveAll(T).filter((a) => a.op === "leave").map((a) => a.room!);
  assert.equal(rooms.includes("e-Pair111"), true);
  assert.equal(rooms.includes("t:Pair111"), true);
});
