import { PublicKey } from "@solana/web3.js";
import { derivePumpPair, isPumpCa } from "../pump-pair";
import type { TokenInfo } from "./viewer-service";

export const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
export const DEFAULT_DEPLOY_WATCH_POLL_MS = 250;

export interface DeployWatchConfig {
  rpcUrl: string;
  wsUrl?: string;
  pollMs: number;
}

export interface ParsedDeployWatchInput {
  ca: string;
  mint: PublicKey;
  pairAddress: string;
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function getDeployWatchConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DeployWatchConfig {
  const rawRpc = env.SOLANA_RPC_URL?.trim();
  const rawWs = env.SOLANA_WS_URL?.trim();
  const rawPoll = Number(env.DEPLOY_WATCH_POLL_MS);
  const pollMs =
    Number.isFinite(rawPoll) && rawPoll >= 50
      ? Math.floor(rawPoll)
      : DEFAULT_DEPLOY_WATCH_POLL_MS;

  return {
    rpcUrl: rawRpc || DEFAULT_SOLANA_RPC_URL,
    wsUrl: rawWs || undefined,
    pollMs,
  };
}

export function isBareCaInput(input: string): boolean {
  return BASE58_ADDRESS.test(input.trim());
}

export function parseDeployWatchInput(input: string): ParsedDeployWatchInput {
  const value = input.trim();
  if (!value || !BASE58_ADDRESS.test(value)) {
    throw new Error("Watch deploy requires a bare token CA, not an axiom.trade link.");
  }

  let mint: PublicKey;
  try {
    mint = new PublicKey(value);
  } catch {
    throw new Error("Invalid Solana CA.");
  }

  if (!isPumpCa(value)) {
    throw new Error("Watch deploy currently supports pump.fun CAs ending in pump.");
  }

  const pairAddress = derivePumpPair(value);
  if (!pairAddress) {
    throw new Error("Could not derive pump pair from CA.");
  }

  return { ca: mint.toBase58(), mint, pairAddress };
}

export function buildDeployTokenInfo(parsed: ParsedDeployWatchInput): TokenInfo {
  return {
    pairAddress: parsed.pairAddress,
    tokenAddress: parsed.ca,
    ticker: "TOKEN",
    name: "Token",
    protocol: "Pump V1",
    isMigrated: false,
    supply: 1000000000,
    price: 0,
  };
}
