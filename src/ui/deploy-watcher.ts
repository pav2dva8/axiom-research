import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { Agent as HttpsAgent } from "https";
import {
  Connection,
  PublicKey,
  type AccountChangeCallback,
  type AccountInfo,
  type Commitment,
  type Context,
  type RpcResponseAndContext,
} from "@solana/web3.js";
import { derivePumpPair } from "../pump-pair";
import type { TokenInfo } from "./viewer-service";
import {
  DEFAULT_ROBINHOOD_RPC_URL,
  createHttpRobinhoodRpcClient,
  findUniswapV3WethPool,
  isRobinhoodCaInput,
  normalizeHexAddress,
  type RobinhoodRpcClient,
} from "./robinhood-deploy-watch";

export const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
export const DEFAULT_DEPLOY_WATCH_POLL_MS = 250;

export interface DeployWatchConfig {
  rpcUrl: string;
  wsUrl?: string;
  pollMs: number;
  allowInsecureTls: boolean;
  /** Robinhood eth JSON-RPC. Defaults to public mainnet endpoint. */
  robinhoodRpcUrl?: string;
}

export interface ParsedDeployWatchInput {
  ca: string;
  /** Known ahead for Sol pump; empty until detected for Robinhood. */
  pairAddress: string;
  chain: "sol" | "robinhood";
  /** Solana mint pubkey; absent for Robinhood. */
  mint?: PublicKey;
}

export type DeployWatchSource = "initial" | "ws" | "poll";

export type DeployWatchState =
  | "preparing"
  | "watching"
  | "detected"
  | "starting"
  | "canceled"
  | "failed";

export interface DeployWatchEvent {
  state: DeployWatchState;
  message: string;
  ca: string;
  pairAddress?: string;
}

export interface DeployWatchDetection {
  ca: string;
  pairAddress: string;
  detectedAt: number;
  slot: number;
  source: DeployWatchSource;
  chain: "sol" | "robinhood";
}

export interface DeployWatchConnection {
  getAccountInfoAndContext(
    publicKey: PublicKey,
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer> | null>>;
  onAccountChange(
    publicKey: PublicKey,
    callback: AccountChangeCallback,
    commitment?: Commitment,
  ): number;
  removeAccountChangeListener(clientSubscriptionId: number): Promise<void>;
}

export type DeployWatchConnectionFactory = (
  config: DeployWatchConfig,
) => DeployWatchConnection;

export type RobinhoodRpcClientFactory = (
  config: DeployWatchConfig,
) => RobinhoodRpcClient;

export class DeployWatchCanceledError extends Error {
  constructor(message = "Deploy watch canceled.") {
    super(message);
    this.name = "DeployWatchCanceledError";
  }
}

interface ActiveWatch {
  ca: string;
  pairAddress: string;
  canceled: boolean;
  settled: boolean;
  subscriptionId: number | null;
  timer: NodeJS.Timeout | null;
  cleanupPromise: Promise<void> | null;
  cleanup: () => Promise<void>;
  settle: (value: DeployWatchDetection | Error) => Promise<void>;
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEPLOY_WATCH_ENV_KEYS = new Set([
  "SOLANA_RPC_URL",
  "SOLANA_WS_URL",
  "DEPLOY_WATCH_POLL_MS",
  "SOLANA_RPC_ALLOW_INSECURE_TLS",
  "ROBINHOOD_RPC_URL",
]);

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if (
    (quote === `"` || quote === "'") &&
    trimmed.endsWith(quote) &&
    trimmed.length >= 2
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function applyDeployWatchEnvFile(
  contents: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): void {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!DEPLOY_WATCH_ENV_KEYS.has(key) || env[key] !== undefined) {
      continue;
    }

    env[key] = parseEnvValue(line.slice(separator + 1));
  }
}

export function loadDeployWatchEnvFile(
  filePath = path.join(process.cwd(), ".env"),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): void {
  try {
    applyDeployWatchEnvFile(fs.readFileSync(filePath, "utf8"), env);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

export function getDeployWatchConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DeployWatchConfig {
  const rawRpc = env.SOLANA_RPC_URL?.trim();
  const rawWs = env.SOLANA_WS_URL?.trim();
  const rawRobinhoodRpc = env.ROBINHOOD_RPC_URL?.trim();
  const rawPoll = Number(env.DEPLOY_WATCH_POLL_MS);
  const pollMs =
    Number.isFinite(rawPoll) && rawPoll >= 0
      ? Math.floor(rawPoll)
      : DEFAULT_DEPLOY_WATCH_POLL_MS;

  return {
    rpcUrl: rawRpc || DEFAULT_SOLANA_RPC_URL,
    wsUrl: rawWs || undefined,
    pollMs,
    allowInsecureTls: isTruthyEnv(env.SOLANA_RPC_ALLOW_INSECURE_TLS),
    robinhoodRpcUrl: rawRobinhoodRpc || DEFAULT_ROBINHOOD_RPC_URL,
  };
}

export function isBareCaInput(input: string): boolean {
  const value = input.trim();
  return BASE58_ADDRESS.test(value) || isRobinhoodCaInput(value);
}

export function parseDeployWatchInput(input: string): ParsedDeployWatchInput {
  const value = input.trim();
  if (!value) {
    throw new Error("Watch deploy requires a bare token CA, not an axiom.trade link.");
  }

  if (isRobinhoodCaInput(value)) {
    const ca = normalizeHexAddress(value);
    return {
      ca,
      pairAddress: "",
      chain: "robinhood",
    };
  }

  if (!BASE58_ADDRESS.test(value)) {
    throw new Error("Watch deploy requires a bare token CA, not an axiom.trade link.");
  }

  let mint: PublicKey;
  try {
    mint = new PublicKey(value);
  } catch {
    throw new Error("Invalid Solana CA.");
  }

  const pairAddress = derivePumpPair(value);
  if (!pairAddress) {
    throw new Error("Could not derive pump pair from CA.");
  }

  return { ca: mint.toBase58(), mint, pairAddress, chain: "sol" };
}

export function buildDeployTokenInfo(parsed: ParsedDeployWatchInput): TokenInfo {
  if (parsed.chain === "robinhood") {
    return {
      pairAddress: parsed.pairAddress || parsed.ca,
      tokenAddress: parsed.ca,
      ticker: "TOKEN",
      name: "Token",
      protocol: "Uniswap v3",
      isMigrated: false,
      supply: 1000000000,
      price: 0,
      chain: "robinhood",
    };
  }

  return {
    pairAddress: parsed.pairAddress,
    tokenAddress: parsed.ca,
    ticker: "TOKEN",
    name: "Token",
    protocol: "Pump V1",
    isMigrated: false,
    supply: 1000000000,
    price: 0,
    chain: "sol",
  };
}

export function createSolanaConnection(
  config: DeployWatchConfig,
): DeployWatchConnection {
  return new Connection(config.rpcUrl, {
    commitment: "processed",
    ...(config.wsUrl ? { wsEndpoint: config.wsUrl } : {}),
    ...(config.allowInsecureTls && config.rpcUrl.startsWith("https:")
      ? { httpAgent: new HttpsAgent({ rejectUnauthorized: false }) }
      : {}),
  });
}

export class DeployWatcher extends EventEmitter {
  private active: ActiveWatch | null = null;

  constructor(
    private readonly createConnection: DeployWatchConnectionFactory = createSolanaConnection,
    private readonly createRobinhoodRpc: RobinhoodRpcClientFactory = (config) =>
      createHttpRobinhoodRpcClient(
        config.robinhoodRpcUrl || DEFAULT_ROBINHOOD_RPC_URL,
      ),
  ) {
    super();
  }

  isActive(): boolean {
    return this.active !== null;
  }

  onDeployWatch(listener: (event: DeployWatchEvent) => void): () => void {
    this.on("deploy-watch", listener);
    return () => {
      this.off("deploy-watch", listener);
    };
  }

  cancel(message = "Deploy watch canceled."): void {
    const active = this.active;
    if (!active) return;

    active.canceled = true;
    active.settle(new DeployWatchCanceledError(message)).catch(() => {});
  }

  async waitForDeploy(
    parsed: ParsedDeployWatchInput,
    config: DeployWatchConfig = getDeployWatchConfig(),
  ): Promise<DeployWatchDetection> {
    if (parsed.chain === "robinhood") {
      return this.waitForRobinhoodPool(parsed, config);
    }
    return this.waitForSolanaMint(parsed, config);
  }

  private async waitForRobinhoodPool(
    parsed: ParsedDeployWatchInput,
    config: DeployWatchConfig,
  ): Promise<DeployWatchDetection> {
    if (this.active) {
      throw new Error("A deploy watch is already active.");
    }

    const rpc = this.createRobinhoodRpc(config);
    const active: ActiveWatch = {
      ca: parsed.ca,
      pairAddress: parsed.pairAddress,
      canceled: false,
      settled: false,
      subscriptionId: null,
      timer: null,
      cleanupPromise: null,
      cleanup: async () => {},
      settle: async () => {},
    };
    this.active = active;

    const readPool = async (
      source: DeployWatchSource,
    ): Promise<DeployWatchDetection | null> => {
      const hit = await findUniswapV3WethPool(parsed.ca, rpc);
      if (!hit) return null;
      return {
        ca: parsed.ca,
        pairAddress: hit.pool,
        detectedAt: Date.now(),
        slot: hit.blockNumber,
        source,
        chain: "robinhood",
      };
    };

    return await new Promise<DeployWatchDetection>((resolve, reject) => {
      const cleanup = (): Promise<void> => {
        if (active.cleanupPromise) return active.cleanupPromise;
        active.cleanupPromise = (async () => {
          if (active.timer) {
            clearInterval(active.timer);
            active.timer = null;
          }
        })();
        return active.cleanupPromise;
      };

      const settle = async (
        value: DeployWatchDetection | Error,
      ): Promise<void> => {
        if (active.settled) return;
        active.settled = true;
        await cleanup();

        if (value instanceof Error) {
          if (value instanceof DeployWatchCanceledError) {
            this.emitWatch({
              state: "canceled",
              message: value.message,
              ca: active.ca,
              pairAddress: active.pairAddress || undefined,
            });
          } else {
            this.emitWatch({
              state: "failed",
              message: value.message,
              ca: active.ca,
              pairAddress: active.pairAddress || undefined,
            });
          }
          if (this.active === active) this.active = null;
          reject(value);
          return;
        }

        active.pairAddress = value.pairAddress;
        if (this.active === active) this.active = null;
        resolve(value);
      };

      active.cleanup = cleanup;
      active.settle = settle;

      const confirm = async (source: DeployWatchSource): Promise<void> => {
        if (active.canceled || active.settled) return;
        const detection = await readPool(source);
        if (!detection || active.canceled || active.settled) return;
        this.emitWatch({
          state: "detected",
          message: `Robinhood V3 pool detected at block ${detection.slot}.`,
          ca: parsed.ca,
          pairAddress: detection.pairAddress,
        });
        await settle(detection);
      };

      const start = async (): Promise<void> => {
        try {
          const initial = await readPool("initial");
          if (active.canceled || active.settled) return;
          if (initial) {
            this.emitWatch({
              state: "detected",
              message: `Robinhood V3 pool detected at block ${initial.slot}.`,
              ca: parsed.ca,
              pairAddress: initial.pairAddress,
            });
            await settle(initial);
            return;
          }

          this.emitWatch({
            state: "watching",
            message: `Watching Robinhood Uniswap V3 WETH pool for ${parsed.ca}.`,
            ca: parsed.ca,
          });

          active.timer = setInterval(() => {
            confirm("poll").catch((err) => {
              settle(err instanceof Error ? err : new Error(String(err))).catch(
                () => {},
              );
            });
          }, config.pollMs);
        } catch (err) {
          await settle(err instanceof Error ? err : new Error(String(err)));
        }
      };

      start().catch((err) => {
        settle(err instanceof Error ? err : new Error(String(err))).catch(() => {});
      });
    });
  }

  private async waitForSolanaMint(
    parsed: ParsedDeployWatchInput,
    config: DeployWatchConfig,
  ): Promise<DeployWatchDetection> {
    if (this.active) {
      throw new Error("A deploy watch is already active.");
    }
    if (!parsed.mint) {
      throw new Error("Solana deploy watch requires a mint pubkey.");
    }

    const connection = this.createConnection(config);
    const mint = parsed.mint;
    const active: ActiveWatch = {
      ca: parsed.ca,
      pairAddress: parsed.pairAddress,
      canceled: false,
      settled: false,
      subscriptionId: null,
      timer: null,
      cleanupPromise: null,
      cleanup: async () => {},
      settle: async () => {},
    };
    this.active = active;

    const readAccount = async (
      source: DeployWatchSource,
    ): Promise<DeployWatchDetection | null> => {
      const result = await connection.getAccountInfoAndContext(
        mint,
        "processed",
      );
      if (!result.value) return null;

      return {
        ca: parsed.ca,
        pairAddress: parsed.pairAddress,
        detectedAt: Date.now(),
        slot: result.context.slot,
        source,
        chain: "sol",
      };
    };

    return await new Promise<DeployWatchDetection>((resolve, reject) => {
      const cleanup = (): Promise<void> => {
        if (active.cleanupPromise) {
          return active.cleanupPromise;
        }

        active.cleanupPromise = (async () => {
          if (active.timer) {
            clearInterval(active.timer);
            active.timer = null;
          }

          if (active.subscriptionId !== null) {
            const id = active.subscriptionId;
            active.subscriptionId = null;
            await connection.removeAccountChangeListener(id).catch(() => {});
          }
        })();

        return active.cleanupPromise;
      };

      const settle = async (
        value: DeployWatchDetection | Error,
      ): Promise<void> => {
        if (active.settled) return;
        active.settled = true;

        await cleanup();

        if (value instanceof Error) {
          if (value instanceof DeployWatchCanceledError) {
            this.emitWatch({
              state: "canceled",
              message: value.message,
              ca: active.ca,
              pairAddress: active.pairAddress,
            });
          } else {
            this.emitWatch({
              state: "failed",
              message: value.message,
              ca: active.ca,
              pairAddress: active.pairAddress,
            });
          }
          if (this.active === active) {
            this.active = null;
          }
          reject(value);
          return;
        }

        if (this.active === active) {
          this.active = null;
        }
        resolve(value);
      };

      active.cleanup = cleanup;
      active.settle = settle;

      const confirm = async (source: DeployWatchSource): Promise<void> => {
        if (active.canceled || active.settled) {
          return;
        }

        const detection = await readAccount(source);
        if (!detection || active.canceled || active.settled) {
          return;
        }

        this.emitWatch({
          state: "detected",
          message: `Mint detected at slot ${detection.slot}.`,
          ca: parsed.ca,
          pairAddress: parsed.pairAddress,
        });
        await settle(detection);
      };

      const start = async (): Promise<void> => {
        try {
          const initial = await readAccount("initial");
          if (active.canceled || active.settled) {
            return;
          }

          if (initial) {
            this.emitWatch({
              state: "detected",
              message: `Mint detected at slot ${initial.slot}.`,
              ca: parsed.ca,
              pairAddress: parsed.pairAddress,
            });
            await settle(initial);
            return;
          }

          this.emitWatch({
            state: "watching",
            message: `Watching mint account ${parsed.ca}.`,
            ca: parsed.ca,
            pairAddress: parsed.pairAddress,
          });

          if (config.wsUrl) {
            try {
              active.subscriptionId = connection.onAccountChange(
                mint,
                (_accountInfo: AccountInfo<Buffer>, _context: Context) => {
                  confirm("ws").catch((err) => {
                    settle(err instanceof Error ? err : new Error(String(err))).catch(
                      () => {},
                    );
                  });
                },
                "processed",
              );
            } catch (err: any) {
              this.emitWatch({
                state: "watching",
                message: `Solana WS setup failed (${err.message}); polling mint account.`,
                ca: parsed.ca,
                pairAddress: parsed.pairAddress,
              });
            }
          }

          active.timer = setInterval(() => {
            confirm("poll").catch((err) => {
              settle(err instanceof Error ? err : new Error(String(err))).catch(
                () => {},
              );
            });
          }, config.pollMs);
        } catch (err) {
          await settle(err instanceof Error ? err : new Error(String(err)));
        }
      };

      start().catch((err) => {
        settle(err instanceof Error ? err : new Error(String(err))).catch(() => {});
      });
    });
  }

  private emitWatch(event: DeployWatchEvent): void {
    this.emit("deploy-watch", event);
  }
}
