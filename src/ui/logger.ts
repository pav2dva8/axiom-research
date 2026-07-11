import * as fs from "fs";
import * as path from "path";
import { formatWithOptions } from "util";

const LOGS_DIR = path.join(process.cwd(), "logs");
const MAX_TAIL_BYTES = 200_000;

let installed = false;

function todayStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export function getCurrentLogFile(date = new Date()): string {
  return path.join(LOGS_DIR, `viewer-ui-${todayStamp(date)}.log`);
}

export function redactLogSecrets(value: string): string {
  return value
    .replace(/Bearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "Bearer [jwt]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/\b(auth-access-token=)[^;\s]+/g, "$1[redacted]")
    .replace(/\b(auth-refresh-token=)[^;\s]+/g, "$1[redacted]")
    .replace(/\b(cf_clearance=)[^;\s]+/g, "$1[redacted]")
    .replace(/\b(__cf_bm=)[^;\s]+/g, "$1[redacted]")
    .replace(/((?:https?|socks5h?|socks4):\/\/[^:\s/@]+:)[^@\s]+(@)/g, "$1[redacted]$2")
    .replace(/([?&](?:accessToken|refreshToken|token|password|pass)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b((?:proxyPassword|password|pass)\s*[:=]\s*)(['"]?)[^,'"\s}]+(\2)/gi, "$1$2[redacted]$2");
}

function formatArgs(args: unknown[]): string {
  return redactLogSecrets(formatWithOptions({ colors: false, depth: 5 }, ...args));
}

function appendLogLine(level: string, args: unknown[]): void {
  try {
    ensureLogsDir();
    const line = `[${new Date().toISOString()}] [${level}] ${formatArgs(args)}\n`;
    fs.appendFileSync(getCurrentLogFile(), line, "utf-8");
  } catch {
    // Logging must never break the bot.
  }
}

export function installFileLogger(): void {
  if (installed) return;
  installed = true;

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    appendLogLine("info", args);
    originalLog(...args);
  };

  console.warn = (...args: unknown[]) => {
    appendLogLine("warn", args);
    originalWarn(...args);
  };

  console.error = (...args: unknown[]) => {
    appendLogLine("error", args);
    originalError(...args);
  };
}

export function readCurrentLogTail(maxBytes = MAX_TAIL_BYTES): { file: string; content: string } {
  const file = getCurrentLogFile();
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return { file, content: buffer.toString("utf-8") };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { file, content: "" };
  }
}
