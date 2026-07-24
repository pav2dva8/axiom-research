import * as fs from "node:fs";
import * as path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import type { AuthTokens, WalletInfo } from "../auth";
import { loadProxyFile } from "../proxy-groups";
import type { ProxyConfig } from "../proxy-groups";
import {
  freshKeysFilename,
  normalizeRegisterOptions,
} from "./register-config";

export interface RegisterProgress {
  phase: "started" | "progress" | "finished" | "stopped";
  message: string;
  succeeded: number;
  failed: number;
  outputFile: string;
  ipIndex?: number;
  ipLabel?: string;
  attempt?: number;
}

export class RegisterRunError extends Error {
  progress: RegisterProgress;

  constructor(message: string, progress: RegisterProgress, cause?: unknown) {
    super(message);
    this.name = "RegisterRunError";
    this.progress = progress;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export interface RegisterSignupSession {
  signupAccount(wallet: WalletInfo): Promise<AuthTokens>;
  close(): Promise<void>;
}

export interface RegisterSessionContext {
  label: string;
  proxy?: ProxyConfig;
}

export interface RegisterServiceDeps {
  openSession: (ctx: RegisterSessionContext) => Promise<RegisterSignupSession>;
  loadProxies: () => ProxyConfig[];
  generateWallet: () => { publicKey: string; secretKeyBase58: string; wallet: WalletInfo };
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  cwd: string;
}

type RawRegisterOptions = Parameters<typeof normalizeRegisterOptions>[0];

type RegisterIp =
  | { kind: "direct"; label: string; proxy?: undefined }
  | { kind: "proxy"; label: string; proxy: ProxyConfig };

/**
 * Each signup gets up to SIGNUP_RETRIES extra tries (3 total) before the
 * attempt is counted as failed. Retries only help with transient errors
 * (network blip, Turnstile timeout); a persistent outage burns all retries.
 */
const SIGNUP_RETRIES = 2;

/**
 * Stop the entire job after this many CONSECUTIVE signup failures (each after
 * exhausting its retries). A single success resets the counter. This caps the
 * damage from a systemic outage (CF block, Axiom ban) without killing the job
 * on a one-off transient error.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

async function defaultOpenSession(ctx: RegisterSessionContext): Promise<RegisterSignupSession> {
  const { openBrowserSession, buildProxyKeepWarmBrowserSessionOptions } = await import("../browser-auth");
  const session = ctx.proxy
    ? await openBrowserSession(
        buildProxyKeepWarmBrowserSessionOptions(
          {
            server: ctx.proxy.server,
            username: ctx.proxy.username,
            password: ctx.proxy.password,
            label: ctx.proxy.label,
          },
          ctx.label,
          (message) => console.warn(`[Register:${ctx.label}] Cloudflare: ${message}`),
        ),
      )
    : await openBrowserSession({
        label: ctx.label,
        surfaceOnCloudflareChallenge: true,
        onCloudflareChallenge: (message) =>
          console.warn(`[Register:${ctx.label}] Cloudflare: ${message}`),
      });

  return {
    signupAccount: (wallet) => session.signupAccount(wallet),
    close: () => session.close(),
  };
}

function defaultDeps(): RegisterServiceDeps {
  return {
    cwd: process.cwd(),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadProxies: () => loadProxyFile(),
    generateWallet: () => {
      const keypair = Keypair.generate();
      const wallet: WalletInfo = {
        publicKey: keypair.publicKey.toBase58(),
        secretKey: keypair.secretKey,
        keypair,
      };
      return {
        publicKey: wallet.publicKey,
        secretKeyBase58: bs58.encode(wallet.secretKey),
        wallet,
      };
    },
    openSession: defaultOpenSession,
  };
}

export class RegisterService {
  private stopRequested = false;
  private running = false;
  private deps: RegisterServiceDeps;

  constructor(deps: Partial<RegisterServiceDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  isRunning(): boolean {
    return this.running;
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  async run(
    rawOpts: RawRegisterOptions,
    onProgress: (progress: RegisterProgress) => void,
  ): Promise<RegisterProgress> {
    if (this.running) throw new Error("Register job already running");

    this.running = true;
    this.stopRequested = false;

    const opts = normalizeRegisterOptions(rawOpts);
    const outputFile = path.join(this.deps.cwd, freshKeysFilename(this.deps.now()));
    let succeeded = 0;
    let failed = 0;
    let consecutiveFailures = 0;

    const progress = (
      phase: RegisterProgress["phase"],
      message: string,
      extra: Partial<RegisterProgress> = {},
    ): RegisterProgress => ({
      phase,
      message,
      succeeded,
      failed,
      outputFile,
      ...extra,
    });

    try {
      const ips = this.resolveIps(opts.useProxies);
      onProgress(progress("started", "Register job started (browser + Cloudflare Turnstile)"));

      for (let ipIndex = 0; ipIndex < ips.length; ipIndex++) {
        const ip = ips[ipIndex];
        if (this.stopRequested) {
          const stopped = progress("stopped", "Register job stopped", {
            ipIndex,
            ipLabel: ip.label,
          });
          onProgress(stopped);
          return stopped;
        }

        onProgress(
          progress("progress", `Opening browser for ${ip.label}...`, {
            ipIndex,
            ipLabel: ip.label,
          }),
        );

        let session: RegisterSignupSession | undefined;
        try {
          session = await this.deps.openSession({
            label: ip.label,
            proxy: ip.proxy,
          });

          for (let attempt = 1; attempt <= opts.amountPerIp; attempt++) {
            if (this.stopRequested) {
              const stopped = progress("stopped", "Register job stopped", {
                ipIndex,
                ipLabel: ip.label,
                attempt,
              });
              onProgress(stopped);
              return stopped;
            }

            const attemptInfo = { ipIndex, ipLabel: ip.label, attempt };
            onProgress(
              progress("progress", `Registering ${ip.label} attempt ${attempt}`, attemptInfo),
            );

            const generated = this.deps.generateWallet();
            let tokens: AuthTokens | undefined;
            let lastError: unknown;
            for (
              let tryNum = 1;
              tryNum <= SIGNUP_RETRIES + 1 && !this.stopRequested;
              tryNum++
            ) {
              try {
                tokens = await session.signupAccount(generated.wallet);
                break;
              } catch (error) {
                lastError = error;
                if (tryNum <= SIGNUP_RETRIES) {
                  const msg = error instanceof Error ? error.message : String(error);
                  onProgress(
                    progress(
                      "progress",
                      `Signup error on ${ip.label} (${msg}); retrying ${tryNum}/${SIGNUP_RETRIES}`,
                      { ...attemptInfo, attempt: tryNum },
                    ),
                  );
                  // Brief backoff between retries on the same proxy.
                  if (opts.delaySec > 0) await this.deps.sleep(opts.delaySec * 1000);
                }
              }
            }

            if (this.stopRequested) {
              // A stop landed mid-signup (possibly during a retry). Don't start
              // new work, but if THIS signup already succeeded fall through to
              // write+count it so a completed registration isn't discarded.
              if (!tokens) {
                const stopped = progress("stopped", "Register job stopped", {
                  ipIndex,
                  ipLabel: ip.label,
                  attempt,
                });
                onProgress(stopped);
                return stopped;
              }
            }

            if (!tokens) {
              // All retries exhausted for this signup.
              failed++;
              consecutiveFailures++;
              const message =
                lastError instanceof Error ? lastError.message : String(lastError);
              if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                const stopped = progress(
                  "stopped",
                  `Stopped after ${consecutiveFailures} consecutive signup failures (${message})`,
                  attemptInfo,
                );
                onProgress(stopped);
                return stopped;
              }
              // Not consecutive enough to stop — log and continue to next attempt.
              onProgress(
                progress(
                  "progress",
                  `Signup failed on ${ip.label} after retries; continuing (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} consecutive)`,
                  attemptInfo,
                ),
              );
              continue;
            }

            // Success: reset the consecutive-failure counter.
            consecutiveFailures = 0;
            try {
              this.writeAccount(generated.publicKey, generated.secretKeyBase58, tokens, outputFile);
            } catch (error) {
              failed++;
              throw error;
            }
            succeeded++;
            onProgress(progress("progress", "Signup succeeded", attemptInfo));

            if (!this.stopRequested && attempt < opts.amountPerIp && opts.delaySec > 0) {
              await this.deps.sleep(opts.delaySec * 1000);
            }
          }
        } finally {
          await session?.close().catch(() => {});
        }
      }

      const donePhase = this.stopRequested ? "stopped" : "finished";
      const done = progress(
        donePhase,
        this.stopRequested ? "Register job stopped" : "Register job finished",
      );
      onProgress(done);
      return done;
    } catch (error) {
      if (error instanceof RegisterRunError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new RegisterRunError(message, progress("finished", message), error);
    } finally {
      this.running = false;
    }
  }

  private resolveIps(useProxies: boolean): RegisterIp[] {
    if (!useProxies) return [{ kind: "direct", label: "direct" }];

    const proxies = this.deps.loadProxies();
    if (proxies.length === 0) throw new Error("No proxies available for register job");

    return proxies.map((proxy) => ({
      kind: "proxy" as const,
      label: proxy.label,
      proxy,
    }));
  }

  private writeAccount(
    publicKey: string,
    secretKeyBase58: string,
    tokens: AuthTokens,
    outputFile: string,
  ): void {
    const tokensDir = path.join(this.deps.cwd, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });
    fs.writeFileSync(path.join(tokensDir, `${publicKey}.json`), JSON.stringify(tokens, null, 2));

    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.appendFileSync(outputFile, `${secretKeyBase58}\n`);
  }
}
