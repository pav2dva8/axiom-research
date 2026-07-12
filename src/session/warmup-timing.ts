export type WarmupDelay = number | readonly [number, number];

export interface WarmupTiming {
  contextGapMs?: WarmupDelay;
  dwellMs?: WarmupDelay;
  wait?: (ms: number) => Promise<void>;
  rng?: () => number;
}

export interface ResolvedWarmupTiming {
  contextGapMs: WarmupDelay;
  dwellMs: WarmupDelay;
  wait: (ms: number) => Promise<void>;
  rng: () => number;
}

export const DEFAULT_CONTEXT_GAP_MS: readonly [number, number] = [10_000, 40_000];
export const DEFAULT_DWELL_MS: readonly [number, number] = [45_000, 180_000];

export function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveWarmupTiming(timing: WarmupTiming = {}): ResolvedWarmupTiming {
  return {
    contextGapMs: timing.contextGapMs ?? DEFAULT_CONTEXT_GAP_MS,
    dwellMs: timing.dwellMs ?? DEFAULT_DWELL_MS,
    wait: timing.wait ?? defaultWait,
    rng: timing.rng ?? Math.random,
  };
}

export function pickDelayMs(delay: WarmupDelay, rng: () => number): number {
  if (typeof delay === "number") return Math.max(0, delay);

  const [min, max] = delay;
  const low = Math.max(0, Math.min(min, max));
  const high = Math.max(0, Math.max(min, max));
  if (high === low) return low;

  return low + Math.floor(rng() * (high - low + 1));
}
