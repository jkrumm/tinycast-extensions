// Finds the scanner without a hostname anywhere in the repo: Bonjour via
// `dns-sd` (`_uscan._tcp`, the eSCL service type). `dns-sd` never exits, so it
// is read until the line we need appears and then killed. The answer is cached
// in `<stateDir>/scanner.json`; a cached host that no longer answers is
// discovered again once.

import { spawn } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseBrowse, parseLookup } from "./escl";

const DNS_SD_BIN = "/usr/bin/dns-sd";
const DNS_SD_CAP_MS = 4000;

export interface CachedScanner {
  host: string;
  at: number;
}

// Runs `dns-sd`, feeds the accumulated stdout to `parse` after every chunk and
// resolves with its first non-null result (or null at the cap / on exit).
export type DnsSdRun = (
  args: string[],
  parse: (stdout: string) => string | null,
  capMs: number,
) => Promise<string | null>;

export interface DiscoverPorts {
  dnsSd: DnsSdRun;
  reachable(host: string): Promise<boolean>;
  readCache(): CachedScanner | null;
  writeCache(cache: CachedScanner): void;
  now(): number;
}

export async function discoverScanner(dnsSd: DnsSdRun): Promise<string | null> {
  const instance = await dnsSd(
    ["-B", "_uscan._tcp", "local."],
    parseBrowse,
    DNS_SD_CAP_MS,
  );
  if (!instance) return null;
  return dnsSd(
    ["-L", instance, "_uscan._tcp", "local."],
    parseLookup,
    DNS_SD_CAP_MS,
  );
}

export async function resolveScannerHost(
  ports: DiscoverPorts,
): Promise<string | null> {
  const cached = ports.readCache();
  if (cached && (await ports.reachable(cached.host))) return cached.host;
  const host = await discoverScanner(ports.dnsSd);
  if (host) ports.writeCache({ host, at: ports.now() });
  return host;
}

export const runDnsSd: DnsSdRun = (args, parse, capMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn(DNS_SD_BIN, args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(parse(stdout)), capMs);
    child.on("error", () => finish(null));
    child.on("close", () => finish(parse(stdout)));
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const found = parse(stdout);
      if (found) finish(found);
    });
  });

export function fileScannerCache(stateDir: string): {
  readCache(): CachedScanner | null;
  writeCache(cache: CachedScanner): void;
} {
  const path = join(stateDir, "scanner.json");
  return {
    readCache() {
      try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        return typeof value?.host === "string" && typeof value?.at === "number"
          ? { host: value.host, at: value.at }
          : null;
      } catch {
        return null;
      }
    },
    writeCache(cache) {
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(path, JSON.stringify(cache));
      } catch {
        // A cache that cannot be written is rediscovered next time.
      }
    },
  };
}
