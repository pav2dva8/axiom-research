/**
 * Default chain. Solana tokens have no explicit chain in most legacy code paths;
 * cross-chain tokens (robinhood, bnb, eth) pass an explicit chain so the
 * friends pageUpdate declares presence on the correct chain.
 */
const DEFAULT_CHAIN = "sol";

export function pageUpdateDiscover(chain: string = DEFAULT_CHAIN): object {
  return {
    type: "pageUpdate",
    page: "discover",
    subpage: { tab: "DEX Screener" },
    chain,
  };
}

export function pageUpdatePulse(chain: string = DEFAULT_CHAIN): object {
  return {
    type: "pageUpdate",
    page: "pulse",
    chain,
  };
}

export function pageUpdateMeme(
  tokenInfo: { pairAddress: string } & Record<string, unknown>,
  chain: string = DEFAULT_CHAIN,
): object {
  return {
    type: "pageUpdate",
    page: "meme",
    subpage: tokenInfo,
    chain,
  };
}
