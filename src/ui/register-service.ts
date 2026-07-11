import * as fs from "node:fs";
import * as path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { HttpsProxyAgent } from "https-proxy-agent";

import { signup as authSignup } from "../auth";
import type { AuthTokens, WalletInfo } from "../auth";
import { loadProxyFile } from "../proxy-groups";
import type { ProxyConfig } from "../proxy-groups";
import {
  freshKeysFilename,
  normalizeRegisterOptions,
  proxyConfigToAgentUrl,
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

export interface RegisterServiceDeps {
  signup: (wallet: WalletInfo, agent?: any) => Promise<AuthTokens>;
  loadProxies: () => ProxyConfig[];
  generateWallet: () => { publicKey: string; secretKeyBase58: string; wallet: WalletInfo };
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  cwd: string;
  createAgent?: (proxyUrl: string) => any;
}

type RawRegisterOptions = Parameters<typeof normalizeRegisterOptions>[0];

type RegisterIp =
  | { kind: "direct"; label: string; agent?: undefined }
  | { kind: "proxy"; label: string; agent: any };

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
    signup: (wallet, agent) => authSignup(wallet, undefined, undefined, agent),
    createAgent: (proxyUrl) => new HttpsProxyAgent(proxyUrl),
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
      const started = progress("started", "Register job started");
      onProgress(started);

      for (let ipIndex = 0; ipIndex < ips.length; ipIndex++) {
        const ip = ips[ipIndex];
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
          onProgress(progress("progress", `Registering ${ip.label} attempt ${attempt}`, attemptInfo));

          try {
            const generated = this.deps.generateWallet();
            const tokens = await this.deps.signup(generated.wallet, ip.agent);
            this.writeAccount(generated.publicKey, generated.secretKeyBase58, tokens, outputFile);
            succeeded++;
            onProgress(progress("progress", "Signup succeeded", attemptInfo));
          } catch (error) {
            failed++;
            const message = error instanceof Error ? error.message : String(error);
            onProgress(progress("progress", `Signup failed: ${message}`, attemptInfo));
            break;
          }

          if (!this.stopRequested && attempt < opts.amountPerIp && opts.delaySec > 0) {
            await this.deps.sleep(opts.delaySec * 1000);
          }
        }
      }

      const donePhase = this.stopRequested ? "stopped" : "finished";
      const done = progress(donePhase, this.stopRequested ? "Register job stopped" : "Register job finished");
      onProgress(done);
      return done;
    } finally {
      this.running = false;
    }
  }

  private resolveIps(useProxies: boolean): RegisterIp[] {
    if (!useProxies) return [{ kind: "direct", label: "direct" }];

    const proxies = this.deps.loadProxies();
    if (proxies.length === 0) throw new Error("No proxies available for register job");

    return proxies.map((proxy) => {
      const proxyUrl = proxyConfigToAgentUrl(proxy);
      return {
        kind: "proxy",
        label: proxy.label,
        agent: this.deps.createAgent?.(proxyUrl),
      };
    });
  }

  private writeAccount(
    publicKey: string,
    secretKeyBase58: string,
    tokens: AuthTokens,
    outputFile: string,
  ): void {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.appendFileSync(outputFile, `${secretKeyBase58}\n`);

    const tokensDir = path.join(this.deps.cwd, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });
    fs.writeFileSync(path.join(tokensDir, `${publicKey}.json`), JSON.stringify(tokens, null, 2));
  }
}
