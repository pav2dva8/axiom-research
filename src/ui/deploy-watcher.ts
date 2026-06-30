import { EventEmitter } from "events";
import {
  Connection,
  PublicKey,
  type AccountChangeCallback,
  type AccountInfo,
  type Commitment,
  type Context,
  type RpcResponseAndContext,
} from "@solana/web3.js";
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

export function getDeployWatchConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DeployWatchConfig {
  const rawRpc = env.SOLANA_RPC_URL?.trim();
  const rawWs = env.SOLANA_WS_URL?.trim();
  const rawPoll = Number(env.DEPLOY_WATCH_POLL_MS);
  const pollMs =
    Number.isFinite(rawPoll) && rawPoll >= 0
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

export function createSolanaConnection(
  config: DeployWatchConfig,
): DeployWatchConnection {
  return new Connection(
    config.rpcUrl,
    config.wsUrl
      ? { commitment: "processed", wsEndpoint: config.wsUrl }
      : "processed",
  );
}

export class DeployWatcher extends EventEmitter {
  private active: ActiveWatch | null = null;

  constructor(
    private readonly createConnection: DeployWatchConnectionFactory = createSolanaConnection,
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
    if (this.active) {
      throw new Error("A deploy watch is already active.");
    }

    const connection = this.createConnection(config);
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
        parsed.mint,
        "processed",
      );
      if (!result.value) return null;

      return {
        ca: parsed.ca,
        pairAddress: parsed.pairAddress,
        detectedAt: Date.now(),
        slot: result.context.slot,
        source,
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
                parsed.mint,
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
