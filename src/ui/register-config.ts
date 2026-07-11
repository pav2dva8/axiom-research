import type { ProxyConfig } from "../proxy-groups";

export const REGISTER_AMOUNT_MIN = 1;
export const REGISTER_AMOUNT_MAX = 3;
export const DEFAULT_REGISTER_AMOUNT_PER_IP = 3;
export const DEFAULT_REGISTER_DELAY_SEC = 5;

export interface RegisterOptions {
  amountPerIp: number;
  delaySec: number;
  useProxies: boolean;
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export function normalizeRegisterOptions(input: {
  amountPerIp?: unknown;
  delaySec?: unknown;
  useProxies?: unknown;
}): RegisterOptions {
  const amountRaw = toFiniteNumber(input.amountPerIp);
  const delayRaw = toFiniteNumber(input.delaySec);
  const amountPerIp = Math.min(
    REGISTER_AMOUNT_MAX,
    Math.max(REGISTER_AMOUNT_MIN, Math.floor(amountRaw ?? DEFAULT_REGISTER_AMOUNT_PER_IP)),
  );
  const delaySec = Math.max(0, Math.floor(delayRaw ?? DEFAULT_REGISTER_DELAY_SEC));
  return {
    amountPerIp,
    delaySec,
    useProxies: input.useProxies === true,
  };
}

export function freshKeysFilename(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}_fresh_keys.txt`;
}

export function proxyConfigToAgentUrl(
  proxy: Pick<ProxyConfig, "server" | "username" | "password">,
): string {
  const url = new URL(proxy.server);
  if (proxy.username) url.username = proxy.username;
  if (proxy.password) url.password = proxy.password;
  return url.toString().replace(/\/$/, "");
}
