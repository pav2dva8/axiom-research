/**
 * Policy for friends/cluster WS recovery after idle 1006 drops.
 *
 * When `friendsReconnectDelayMs` is set (Test pageUpdate longevity), both
 * sockets may be reopened after a fixed delay instead of tearing the session
 * down when cluster dies first.
 */

export interface SocketReconnectState {
  closed: boolean;
  /** Fixed reconnect delay from Test tab; absent = classic fast/backoff mode. */
  friendsReconnectDelayMs?: number | null;
}

/** True when idle socket drops should schedule a reconnect instead of teardown. */
export function shouldScheduleSocketReconnect(state: SocketReconnectState): boolean {
  if (state.closed) return false;
  return typeof state.friendsReconnectDelayMs === "number";
}

/**
 * Classic mode requires an open cluster before friends can reconnect.
 * Fixed-delay (Test) mode does not — cluster may already be dead/idle-killed.
 */
export function friendsReconnectRequiresOpenCluster(
  state: Pick<SocketReconnectState, "friendsReconnectDelayMs">,
): boolean {
  return typeof state.friendsReconnectDelayMs !== "number";
}

/** Resolve the wait before reopening a socket. */
export function resolveFriendsReconnectDelayMs(
  state: Pick<SocketReconnectState, "friendsReconnectDelayMs">,
  attempt: number,
): number {
  if (typeof state.friendsReconnectDelayMs === "number") {
    return Math.max(0, Math.floor(state.friendsReconnectDelayMs));
  }
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(15_000, 150 * Math.pow(2, n - 1));
  return base;
}
