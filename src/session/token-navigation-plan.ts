import { pageUpdateMeme } from "./page-update";

export type NavAction = {
  atMs: number;
  ws: "cluster" | "friends";
  op: "join" | "leave" | "pageUpdate";
  room?: string;
  pageUpdate?: object;
};

export interface NavTokenRef {
  pairAddress: string;
  tokenAddress: string;
  /** Chain for the friends pageUpdate. Defaults to "sol" when absent. */
  chain?: string;
}

/**
 * Global, token-independent rooms the real browser joins on every cluster9
 * connect (seen at 0ms in the HAR). These broadcast frequently (sol_price,
 * block_hash, sol-priority-fee-v2 emit roughly every second or faster) so
 * subscribing to them keeps the socket fed with inbound traffic. Without this
 * ambient traffic, a viewer that joins only its 6 token rooms can go ~60s
 * with no bytes on the wire and get reaped by a network/proxy idle timer
 * (the observed 1006 drops). Joining these on every open mirrors the browser
 * and keeps the connection non-idle without changing token/viewer behavior.
 */
export const GLOBAL_LIVENESS_ROOMS = [
  "sol_price",
  "btc_price",
  "eth_price",
  "bnb_price",
  "block_hash",
  "sol-priority-fee-v2",
  "connection_monitor",
  "online-users-count",
  "lighthouse",
] as const;

const defaultRng = () => Math.random();

function clusterJoin(atMs: number, room: string): NavAction {
  return { atMs, ws: "cluster", op: "join", room };
}

function clusterLeave(atMs: number, room: string): NavAction {
  return { atMs, ws: "cluster", op: "leave", room };
}

function memePageUpdate(atMs: number, token: NavTokenRef): NavAction {
  return {
    atMs,
    ws: "friends",
    op: "pageUpdate",
    pageUpdate: pageUpdateMeme(
      {
        pairAddress: token.pairAddress,
        tokenAddress: token.tokenAddress,
      },
      token.chain ?? "sol",
    ),
  };
}

function allClusterRooms(ref: NavTokenRef): string[] {
  const { pairAddress: pair, tokenAddress: token } = ref;
  return [
    `t:${pair}`,
    `f:${pair}`,
    `${pair}_refresh`,
    `e-${pair}`,
    `td:${pair}`,
    `s:${pair}`,
    `${pair}-dex-paid`,
    `${pair}-wallet_funding`,
    `kol_tx:${pair}`,
    `pump-cto:${pair}`,
    `a:${token}`,
    `soc_bub:${token}`,
    `b-${pair}`,
  ];
}

function enterEarlyRooms(pair: string): string[] {
  return [`t:${pair}`, `f:${pair}`, `${pair}_refresh`];
}

function enterLateRooms(ref: NavTokenRef): string[] {
  const { pairAddress: pair, tokenAddress: token } = ref;
  return [
    `e-${pair}`,
    `td:${pair}`,
    `s:${pair}`,
    `${pair}-dex-paid`,
    `${pair}-wallet_funding`,
    `kol_tx:${pair}`,
    `pump-cto:${pair}`,
    `a:${token}`,
    `soc_bub:${token}`,
  ];
}

function tokenToTokenEarlyJoinRooms(ref: NavTokenRef): string[] {
  const { pairAddress: pair } = ref;
  return [
    `t:${pair}`,
    `f:${pair}`,
    `td:${pair}`,
    `s:${pair}`,
    `${pair}_refresh`,
    `${pair}-dex-paid`,
    `${pair}-wallet_funding`,
    `kol_tx:${pair}`,
    `pump-cto:${pair}`,
  ];
}

function tokenToTokenLateJoinRooms(ref: NavTokenRef): string[] {
  const { pairAddress: pair, tokenAddress: token } = ref;
  return [`e-${pair}`, `a:${token}`, `soc_bub:${token}`, `b-${pair}`];
}

export function planEnterFromFeed(
  token: NavTokenRef,
  rng: () => number = defaultRng,
): NavAction[] {
  const lateAt = 450 + Math.floor(rng() * 350);
  const bAt = lateAt + Math.floor(rng() * 50);

  const plan: NavAction[] = [];
  for (const room of enterEarlyRooms(token.pairAddress)) {
    plan.push(clusterJoin(0, room));
  }
  for (const room of enterLateRooms(token)) {
    plan.push(clusterJoin(lateAt, room));
  }
  plan.push(clusterJoin(bAt, `b-${token.pairAddress}`));
  plan.push(memePageUpdate(lateAt, token));

  return plan.sort((a, b) => a.atMs - b.atMs);
}

/** Longevity-oriented minimal watch: early token rooms + eye room + meme presence. */
export function planMinimalViewer(token: NavTokenRef): NavAction[] {
  const plan: NavAction[] = [];
  for (const room of enterEarlyRooms(token.pairAddress)) {
    plan.push(clusterJoin(0, room));
  }
  plan.push(clusterJoin(0, `e-${token.pairAddress}`));
  plan.push(memePageUpdate(0, token));
  return plan;
}

/**
 * Friends pageUpdate only — no cluster token rooms. The cluster socket still
 * opens (for the liveness rooms joined at connect) but joins no token room.
 * Use this to isolate whether pageUpdate alone drives the viewer count.
 */
export function planPageUpdateOnlyViewer(token: NavTokenRef): NavAction[] {
  return [memePageUpdate(0, token)];
}

export function planTokenToToken(
  prev: NavTokenRef,
  next: NavTokenRef,
  rng: () => number = defaultRng,
): NavAction[] {
  const leaveLead = 0;
  const firstJoin = leaveLead + 6 + Math.floor(rng() * 4);
  const eLeaveAt = firstJoin + 36 + Math.floor(rng() * 14);
  const lateAt = firstJoin + 250 + Math.floor(rng() * 70);

  const plan: NavAction[] = [];

  for (const room of allClusterRooms(prev)) {
    if (room === `e-${prev.pairAddress}`) continue;
    plan.push(clusterLeave(leaveLead, room));
  }

  for (const room of tokenToTokenEarlyJoinRooms(next)) {
    plan.push(clusterJoin(firstJoin, room));
  }

  plan.push(clusterLeave(eLeaveAt, `e-${prev.pairAddress}`));

  for (const room of tokenToTokenLateJoinRooms(next)) {
    plan.push(clusterJoin(lateAt, room));
  }
  plan.push(memePageUpdate(lateAt, next));

  return plan.sort((a, b) => a.atMs - b.atMs);
}

export function planLeaveAll(token: NavTokenRef): NavAction[] {
  return allClusterRooms(token).map((room) => clusterLeave(0, room));
}
