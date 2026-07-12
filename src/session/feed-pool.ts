export interface FeedToken {
  pairAddress: string;
  tokenAddress: string;
  ticker?: string;
  name?: string;
}

type FetchTrending = () => Promise<unknown>;

const DEFAULT_TTL_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function nestedString(
  record: Record<string, unknown>,
  key: string,
  keys: string[],
): string | undefined {
  const value = record[key];
  if (!isRecord(value)) return undefined;
  return stringAt(value, keys);
}

function tokenFromRecord(record: Record<string, unknown>): FeedToken | null {
  const pairAddress =
    stringAt(record, ["pairAddress"]) ||
    nestedString(record, "pair", ["pairAddress", "address"]);
  const tokenAddress =
    stringAt(record, ["tokenAddress", "tokenMint", "mint"]) ||
    nestedString(record, "token", ["tokenAddress", "tokenMint", "mint", "address"]);

  if (!pairAddress || !tokenAddress) return null;

  const ticker = stringAt(record, ["ticker", "symbol"]) || nestedString(record, "token", ["ticker", "symbol"]);
  const name = stringAt(record, ["name"]) || nestedString(record, "token", ["name"]);
  return {
    pairAddress,
    tokenAddress,
    ...(ticker ? { ticker } : {}),
    ...(name ? { name } : {}),
  };
}

export function parseMemeTrendingPayload(body: unknown): FeedToken[] {
  const tokens: FeedToken[] = [];
  const seen = new Set<string>();

  function add(token: FeedToken): void {
    const key = `${token.pairAddress}:${token.tokenAddress}`;
    if (seen.has(key)) return;
    seen.add(key);
    tokens.push(token);
  }

  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    if (!isRecord(value)) return;

    const token = tokenFromRecord(value);
    if (token) add(token);

    for (const child of Object.values(value)) {
      if (Array.isArray(child) || isRecord(child)) walk(child);
    }
  }

  walk(body);
  return tokens;
}

export class FeedPool {
  private readonly fetchTrending: FetchTrending;
  private readonly ttlMs: number;
  private tokens: FeedToken[] = [];
  private refreshedAt = 0;

  constructor(opts: { fetchTrending: FetchTrending; ttlMs?: number }) {
    this.fetchTrending = opts.fetchTrending;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async refresh(): Promise<void> {
    const now = Date.now();
    if (this.tokens.length > 0 && now - this.refreshedAt < this.ttlMs) return;

    this.tokens = parseMemeTrendingPayload(await this.fetchTrending());
    this.refreshedAt = now;
  }

  pickRandom(rng: () => number = Math.random): FeedToken | null {
    if (this.tokens.length === 0) return null;
    const index = Math.min(this.tokens.length - 1, Math.floor(rng() * this.tokens.length));
    return this.tokens[index];
  }

  list(): FeedToken[] {
    return [...this.tokens];
  }
}
