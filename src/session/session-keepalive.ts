export interface SessionKeepaliveOptions {
  friendsIntervalMs?: number;
  clusterIntervalMs?: number;
  friendsJitterMs?: number;
  /** When false, skip friends "." ticks (cluster-only sessions). Default true. */
  friendsEnabled?: boolean;
  tickFriends: () => void | Promise<void>;
  tickCluster: () => void | Promise<void>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface SessionKeepaliveHandle {
  stop: () => void;
}

/**
 * Drive friends/cluster WS keepalive from Node so Chrome background-tab
 * timer throttling cannot starve the in-page 1 Hz "." pings.
 */
export function startSessionKeepalive(
  opts: SessionKeepaliveOptions,
): SessionKeepaliveHandle {
  const friendsIntervalMs = Math.max(250, Math.floor(opts.friendsIntervalMs ?? 1000));
  const clusterIntervalMs = Math.max(1000, Math.floor(opts.clusterIntervalMs ?? 30_000));
  const friendsJitterMs = Math.max(0, Math.floor(opts.friendsJitterMs ?? 0));
  const friendsEnabled = opts.friendsEnabled !== false;

  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;

  let stopped = false;
  let friendsStartTimer: ReturnType<typeof setTimeout> | null = null;
  let friendsTimer: ReturnType<typeof setInterval> | null = null;
  let clusterTimer: ReturnType<typeof setInterval> | null = null;

  const safeTick = (fn: () => void | Promise<void>): void => {
    if (stopped) return;
    try {
      const result = fn();
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Keepalive must never throw into the timer loop.
    }
  };

  if (friendsEnabled) {
    friendsStartTimer = setTimeoutFn(() => {
      friendsStartTimer = null;
      if (stopped) return;
      safeTick(opts.tickFriends);
      friendsTimer = setIntervalFn(() => safeTick(opts.tickFriends), friendsIntervalMs);
    }, friendsJitterMs);
  }

  clusterTimer = setIntervalFn(() => safeTick(opts.tickCluster), clusterIntervalMs);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (friendsStartTimer != null) clearTimeoutFn(friendsStartTimer);
      if (friendsTimer != null) clearIntervalFn(friendsTimer);
      if (clusterTimer != null) clearIntervalFn(clusterTimer);
      friendsStartTimer = null;
      friendsTimer = null;
      clusterTimer = null;
    },
  };
}
