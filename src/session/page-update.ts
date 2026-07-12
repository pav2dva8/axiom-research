export function pageUpdateDiscover(): object {
  return {
    type: "pageUpdate",
    page: "discover",
    subpage: { tab: "DEX Screener" },
    chain: "sol",
  };
}

export function pageUpdatePulse(): object {
  return {
    type: "pageUpdate",
    page: "pulse",
    chain: "sol",
  };
}

export function pageUpdateMeme(
  tokenInfo: { pairAddress: string } & Record<string, unknown>,
): object {
  return {
    type: "pageUpdate",
    page: "meme",
    subpage: tokenInfo,
    chain: "sol",
  };
}
