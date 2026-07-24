/**
 * Robinhood Chain (Uniswap V3) deploy watch helpers.
 * Bare 0x CA → poll factory.getPool(token, WETH, fee) until a pool appears.
 */

export const DEFAULT_ROBINHOOD_RPC_URL =
  "https://rpc.mainnet.chain.robinhood.com";

/** Uniswap V3 factory on Robinhood mainnet (chainId 4663). */
export const UNISWAP_V3_FACTORY_ROBINHOOD =
  "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";

/** WETH9 on Robinhood mainnet. */
export const ROBINHOOD_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/** Common Uniswap V3 fee tiers (hundredths of a bip). */
export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

const HEX_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const GET_POOL_SELECTOR = "1698ee82"; // getPool(address,address,uint24)

export interface RobinhoodRpcClient {
  ethCall(to: string, data: string): Promise<string>;
  ethBlockNumber(): Promise<number>;
}

export interface RobinhoodPoolHit {
  pool: string;
  fee: number;
  blockNumber: number;
}

export function normalizeHexAddress(input: string): string {
  const value = input.trim();
  if (!HEX_ADDRESS.test(value)) {
    throw new Error("Invalid Robinhood CA.");
  }
  return value.toLowerCase();
}

export function isRobinhoodCaInput(input: string): boolean {
  return HEX_ADDRESS.test(input.trim());
}

function padAddress(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function sortTokens(tokenA: string, tokenB: string): [string, string] {
  const a = normalizeHexAddress(tokenA);
  const b = normalizeHexAddress(tokenB);
  return a < b ? [a, b] : [b, a];
}

/** ABI-encode Uniswap V3 factory.getPool(tokenA, tokenB, fee). */
export function encodeUniswapV3GetPoolCalldata(
  tokenA: string,
  tokenB: string,
  fee: number,
): string {
  const [token0, token1] = sortTokens(tokenA, tokenB);
  const feeHex = Math.floor(fee).toString(16).padStart(64, "0");
  return `0x${GET_POOL_SELECTOR}${padAddress(token0)}${padAddress(token1)}${feeHex}`;
}

export function decodeEthAddressResult(result: string): string | null {
  const hex = (result || "").trim().toLowerCase();
  if (!hex.startsWith("0x") || hex.length < 66) return null;
  const address = `0x${hex.slice(-40)}`;
  if (address === "0x0000000000000000000000000000000000000000") return null;
  if (!HEX_ADDRESS.test(address)) return null;
  return address;
}

export async function findUniswapV3WethPool(
  tokenCa: string,
  client: RobinhoodRpcClient,
  opts: {
    factory?: string;
    weth?: string;
    fees?: readonly number[];
  } = {},
): Promise<RobinhoodPoolHit | null> {
  const ca = normalizeHexAddress(tokenCa);
  const factory = normalizeHexAddress(opts.factory ?? UNISWAP_V3_FACTORY_ROBINHOOD);
  const weth = normalizeHexAddress(opts.weth ?? ROBINHOOD_WETH);
  const fees = opts.fees ?? V3_FEE_TIERS;

  for (const fee of fees) {
    const data = encodeUniswapV3GetPoolCalldata(ca, weth, fee);
    const raw = await client.ethCall(factory, data);
    const pool = decodeEthAddressResult(raw);
    if (pool) {
      const blockNumber = await client.ethBlockNumber();
      return { pool, fee, blockNumber };
    }
  }
  return null;
}

export function createHttpRobinhoodRpcClient(
  rpcUrl: string,
): RobinhoodRpcClient {
  const url = rpcUrl.trim() || DEFAULT_ROBINHOOD_RPC_URL;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) {
      throw new Error(`Robinhood RPC HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      result?: T;
      error?: { message?: string };
    };
    if (body.error) {
      throw new Error(body.error.message || "Robinhood RPC error");
    }
    return body.result as T;
  }

  return {
    async ethCall(to, data) {
      return await rpc<string>("eth_call", [{ to, data }, "latest"]);
    },
    async ethBlockNumber() {
      const hex = await rpc<string>("eth_blockNumber", []);
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) ? n : 0;
    },
  };
}
