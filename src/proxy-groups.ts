import * as fs from 'fs';
import * as path from 'path';

export interface ProxyConfig {
  id: number;
  label: string;
  server: string;
  username?: string;
  password?: string;
}

export interface ProxyAccountGroup {
  id: number;
  label: string;
  proxy: ProxyConfig;
  accounts: string[];
}

function decodeAuthPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseProxyLine(line: string, index: number): ProxyConfig | null {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) return null;

  const id = index + 1;
  const label = `proxy ${id}`;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const url = new URL(raw);
    const scheme = url.protocol.replace(/:$/, '') || 'http';
    const server = `${scheme}://${url.hostname}${url.port ? `:${url.port}` : ''}`;
    return {
      id,
      label,
      server,
      ...(url.username ? { username: decodeAuthPart(url.username) } : {}),
      ...(url.password ? { password: decodeAuthPart(url.password) } : {}),
    };
  }

  const parts = raw.split(':');
  if (parts.length === 4) {
    const [host, port, username, password] = parts;
    return {
      id,
      label,
      server: `http://${host}:${port}`,
      username,
      password,
    };
  }

  if (parts.length === 2) {
    const [host, port] = parts;
    return {
      id,
      label,
      server: `http://${host}:${port}`,
    };
  }

  throw new Error(`Invalid proxy format on line ${id}. Expected host:port:user:pass, host:port, or proxy URL.`);
}

export function loadProxyFile(filePath = path.join(process.cwd(), 'proxies.txt')): ProxyConfig[] {
  if (!fs.existsSync(filePath)) return [];

  const proxies: ProxyConfig[] = [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseProxyLine(lines[i], i);
    if (parsed) proxies.push({ ...parsed, id: proxies.length + 1, label: `proxy ${proxies.length + 1}` });
  }
  return proxies;
}

export function assignAccountsToProxyGroups(accounts: string[], proxies: ProxyConfig[]): ProxyAccountGroup[] {
  if (accounts.length === 0 || proxies.length === 0) return [];

  const activeProxyCount = Math.min(accounts.length, proxies.length);
  const base = Math.floor(accounts.length / activeProxyCount);
  const extra = accounts.length % activeProxyCount;
  const groups: ProxyAccountGroup[] = [];

  let offset = 0;
  for (let i = 0; i < activeProxyCount; i++) {
    const size = base + (i < extra ? 1 : 0);
    const groupAccounts = accounts.slice(offset, offset + size);
    offset += size;
    if (groupAccounts.length === 0) continue;
    groups.push({
      id: i + 1,
      label: proxies[i].label,
      proxy: proxies[i],
      accounts: groupAccounts,
    });
  }

  return groups;
}
