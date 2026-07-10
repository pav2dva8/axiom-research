import { derivePumpPair } from "../pump-pair";
import type { TokenInfo } from "./viewer-service";

const BASE58_ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const BASE58_EXACT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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

export function extractResolveAddress(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(BASE58_ADDRESS);
  return match ? match[0] : trimmed;
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
  };
}

export function resolveTokenInput(input: string): TokenResolveResult {
  if (typeof input !== "string" || !input.trim()) {
    throw new TokenResolveError("input required", 400);
  }

  const trimmed = input.trim();
  const value = extractResolveAddress(trimmed);
  const fromLink = value !== trimmed;

  if (!BASE58_EXACT.test(value)) {
    throw new TokenResolveError("No token CA or axiom link found in input", 400);
  }

  if (fromLink) {
    const tokenInfo = fallbackTokenInfo(value);
    return { tokenInfo, derived: false };
  }

  // UI contract: a bare address is always a token CA. It is never treated as a
  // pair/pool address; users must paste a full Axiom link when they need a
  // specific migrated pool pair.
  const derivedPairAddress = derivePumpPair(value);
  if (derivedPairAddress) {
    const tokenInfo = fallbackTokenInfo(derivedPairAddress, {
      tokenAddress: value,
      protocol: "Pump V1",
    });
    return { tokenInfo, derived: true };
  }

  throw new TokenResolveError(
    "Could not derive pump pair from CA. Paste a full Axiom token link if this is not a pump token.",
    404,
  );
}
