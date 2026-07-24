import { derivePumpPair } from "../pump-pair";
import type { TokenInfo } from "./viewer-service";
import {
  createHttpRobinhoodRpcClient,
  findUniswapV3WethPool,
  type RobinhoodPoolHit,
} from "./robinhood-deploy-watch";

const BASE58_ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
// Ethereum-style hex address (e.g. robinhood/bnb/eth pair addresses).
const HEX_ADDRESS_EXACT = /^0x[a-fA-F0-9]{40}$/i;

const SUPPORTED_CHAINS = new Set(["sol", "robinhood", "bnb", "eth"]);

export class TokenResolveError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface TokenResolveResult {
  tokenInfo: TokenInfo;
  derived: boolean;
}

export interface TokenResolveOptions {
  /** Test seam for Robinhood pool lookup. */
  findRobinhoodPool?: (ca: string) => Promise<RobinhoodPoolHit | null>;
}

/** Extract the first base58-looking token address from an arbitrary string. */
function extractBase58(input: string): string | null {
  const match = input.match(BASE58_ADDRESS);
  return match ? match[0] : null;
}

/** Extract a 0x-prefixed hex address from an arbitrary string. */
function extractHex(input: string): string | null {
  const match = input.match(/0x[a-fA-F0-9]{40}/i);
  return match ? match[0].toLowerCase() : null;
}

/** Parse ?chain= from an axiom.trade link. Returns null when absent/unknown. */
function extractChain(input: string): string | null {
  try {
    const url = new URL(input);
    const chain = url.searchParams.get("chain");
    if (chain && SUPPORTED_CHAINS.has(chain)) return chain;
    return null;
  } catch {
    return null;
  }
}

export function extractResolveAddress(input: string): string {
  const trimmed = input.trim();
  return extractBase58(trimmed) ?? extractHex(trimmed) ?? trimmed;
}

function fallbackTokenInfo(
  pairAddress: string,
  fallback: Partial<TokenInfo> = {},
): TokenInfo {
  return {
    pairAddress,
    tokenAddress: fallback.tokenAddress ?? "",
    ticker: fallback.ticker ?? "TOKEN",
    name: fallback.name ?? "Token",
    protocol: fallback.protocol ?? "Unknown",
    isMigrated: fallback.isMigrated ?? false,
    supply: fallback.supply ?? 1_000_000_000,
    price: fallback.price ?? 0,
    chain: fallback.chain ?? "sol",
  };
}

async function defaultFindRobinhoodPool(ca: string): Promise<RobinhoodPoolHit | null> {
  return findUniswapV3WethPool(ca, createHttpRobinhoodRpcClient(""));
}

/**
 * Resolve a pasted CA or Axiom link.
 * - Bare base58 → Solana pump CA (derive pair)
 * - Bare 0x → always Robinhood token CA (lookup Uniswap V3 WETH pool)
 * - Link with 0x → pair address; chain from ?chain= or default robinhood
 * - Link with base58 → pair address; chain from ?chain= or default sol
 */
export async function resolveTokenInput(
  input: string,
  opts: TokenResolveOptions = {},
): Promise<TokenResolveResult> {
  if (typeof input !== "string" || !input.trim()) {
    throw new TokenResolveError("input required", 400);
  }

  const trimmed = input.trim();
  const hex = extractHex(trimmed);

  // ---- Bare 0x CA: always Robinhood ----
  if (hex && HEX_ADDRESS_EXACT.test(trimmed)) {
    const findPool = opts.findRobinhoodPool ?? defaultFindRobinhoodPool;
    const hit = await findPool(hex);
    if (!hit) {
      throw new TokenResolveError(
        "No Robinhood Uniswap V3 WETH pool for this CA yet. Use Watch deploy to wait for it.",
        404,
      );
    }
    return {
      tokenInfo: fallbackTokenInfo(hit.pool, {
        tokenAddress: hex,
        protocol: "Uniswap v3",
        chain: "robinhood",
      }),
      derived: true,
    };
  }

  // ---- 0x inside an Axiom link (pair address) ----
  if (hex) {
    // Bare 0x is always RH; a link without ?chain= defaults to RH too.
    const chain = extractChain(trimmed) ?? "robinhood";
    const tokenInfo = fallbackTokenInfo(hex, { chain });
    return { tokenInfo, derived: false };
  }

  // ---- Solana link or bare base58 CA ----
  const base58 = extractBase58(trimmed);
  const fromLink = base58 !== null && base58 !== trimmed;

  if (!base58) {
    throw new TokenResolveError("No token CA or axiom link found in input", 400);
  }

  if (fromLink) {
    // A solana link: chain may be ?chain=sol or absent. Use it if present.
    const chain = extractChain(trimmed) ?? "sol";
    const tokenInfo = fallbackTokenInfo(base58, { chain });
    return { tokenInfo, derived: false };
  }

  // UI contract: a bare base58 address is always a Solana token CA. It is
  // never treated as a pair/pool address; users must paste a full Axiom link
  // when they need a specific migrated pool pair.
  const derivedPairAddress = derivePumpPair(base58);
  if (derivedPairAddress) {
    const tokenInfo = fallbackTokenInfo(derivedPairAddress, {
      tokenAddress: base58,
      protocol: "Pump V1",
      chain: "sol",
    });
    return { tokenInfo, derived: true };
  }

  throw new TokenResolveError(
    "Could not derive pump pair from CA. Paste a full Axiom token link if this is not a pump token.",
    404,
  );
}
