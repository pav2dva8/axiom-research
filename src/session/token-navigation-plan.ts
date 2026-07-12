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
}

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
    pageUpdate: pageUpdateMeme({
      pairAddress: token.pairAddress,
      tokenAddress: token.tokenAddress,
    }),
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
