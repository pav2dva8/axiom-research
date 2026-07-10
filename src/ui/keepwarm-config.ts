export interface DelayRangeMs {
  min: number;
  max: number;
}

export interface KeepWarmTimingInput {
  /** Legacy single refresh delay. Prefer refreshDelayMinMs/refreshDelayMaxMs. */
  delayMs?: number;
  /** Legacy single refresh threshold. Prefer refreshThresholdMinMin/MaxMin. */
  thresholdMin?: number;
  groupStartDelayMinMs?: number;
  groupStartDelayMaxMs?: number;
  refreshDelayMinMs?: number;
  refreshDelayMaxMs?: number;
  refreshThresholdMinMin?: number;
  refreshThresholdMaxMin?: number;
}

export interface NormalizedKeepWarmOptions {
  groupStartDelayMs: DelayRangeMs;
  refreshDelayMs: DelayRangeMs;
  refreshThresholdMs: DelayRangeMs;
  accessTokenLifetimeMs: number;
}

export const ACCESS_TOKEN_LIFETIME_MS = 15 * 60_000;

const DEFAULT_GROUP_START_DELAY_MIN_MS = 5000;
const DEFAULT_GROUP_START_DELAY_MAX_MS = 15_000;
const DEFAULT_KEEP_WARM_REFRESH_DELAY_MIN_MS = 5000;
const DEFAULT_KEEP_WARM_REFRESH_DELAY_MAX_MS = 10_000;
const DEFAULT_KEEP_WARM_REFRESH_THRESHOLD_MIN_MS = 2 * 60_000;
const DEFAULT_KEEP_WARM_REFRESH_THRESHOLD_MAX_MS = 6 * 60_000;

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeRange(
  minValue: number | undefined,
  maxValue: number | undefined,
  fallbackMin: number,
  fallbackMax: number,
  floor: number,
): DelayRangeMs {
  const min = Math.max(floor, Math.floor(finiteNumber(minValue, fallbackMin)));
  const max = Math.max(floor, Math.floor(finiteNumber(maxValue, fallbackMax)));
  return max < min ? { min: max, max: min } : { min, max };
}

export function normalizeKeepWarmOptions(input: KeepWarmTimingInput = {}): NormalizedKeepWarmOptions {
  const legacyDelay = input.delayMs;
  const legacyThresholdMs = input.thresholdMin == null ? undefined : input.thresholdMin * 60_000;

  return {
    groupStartDelayMs: normalizeRange(
      input.groupStartDelayMinMs,
      input.groupStartDelayMaxMs,
      DEFAULT_GROUP_START_DELAY_MIN_MS,
      DEFAULT_GROUP_START_DELAY_MAX_MS,
      0,
    ),
    refreshDelayMs: normalizeRange(
      input.refreshDelayMinMs ?? legacyDelay,
      input.refreshDelayMaxMs ?? legacyDelay,
      DEFAULT_KEEP_WARM_REFRESH_DELAY_MIN_MS,
      DEFAULT_KEEP_WARM_REFRESH_DELAY_MAX_MS,
      500,
    ),
    refreshThresholdMs: normalizeRange(
      input.refreshThresholdMinMin == null ? legacyThresholdMs : input.refreshThresholdMinMin * 60_000,
      input.refreshThresholdMaxMin == null ? legacyThresholdMs : input.refreshThresholdMaxMin * 60_000,
      DEFAULT_KEEP_WARM_REFRESH_THRESHOLD_MIN_MS,
      DEFAULT_KEEP_WARM_REFRESH_THRESHOLD_MAX_MS,
      60_000,
    ),
    accessTokenLifetimeMs: ACCESS_TOKEN_LIFETIME_MS,
  };
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function keepWarmRefreshThresholdMs(
  publicKey: string,
  options: NormalizedKeepWarmOptions,
): number {
  const { min, max } = options.refreshThresholdMs;
  if (max <= min) return min;
  return min + (stableHash(publicKey) % (max - min + 1));
}
