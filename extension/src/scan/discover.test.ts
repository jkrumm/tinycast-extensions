import { describe, expect, it } from "vitest";
import {
  CachedScanner,
  discoverScanner,
  DiscoverPorts,
  DnsSdRun,
  resolveScannerHost,
} from "./discover";

const BROWSE =
  "18:28:01.319  Add        2  14 local.               _uscan._tcp.         Example MFC-1234 series\n";
const LOOKUP =
  "18:28:13.698  Example\\032MFC-1234\\032series._uscan._tcp.local. can be reached at EXAMPLE1234.local.:80 (interface 14)\n";

// A dns-sd that answers per sub-command by running the real parser over fixed output.
const fakeDnsSd =
  (calls: string[][] = []): DnsSdRun =>
  async (args, parse) => {
    calls.push(args);
    return parse(args[0] === "-B" ? BROWSE : LOOKUP);
  };

function makePorts(opts: {
  cache?: CachedScanner | null;
  reachable?: boolean;
  dnsSd?: DnsSdRun;
}) {
  const written: CachedScanner[] = [];
  const probed: string[] = [];
  const ports: DiscoverPorts = {
    dnsSd: opts.dnsSd ?? fakeDnsSd(),
    reachable: async (host) => {
      probed.push(host);
      return opts.reachable ?? true;
    },
    readCache: () => opts.cache ?? null,
    writeCache: (c) => written.push(c),
    now: () => 99,
  };
  return { ports, written, probed };
}

describe("discoverScanner", () => {
  it("browses, then looks the instance up", async () => {
    const calls: string[][] = [];
    expect(await discoverScanner(fakeDnsSd(calls))).toBe(
      "http://EXAMPLE1234.local",
    );
    expect(calls).toEqual([
      ["-B", "_uscan._tcp", "local."],
      ["-L", "Example MFC-1234 series", "_uscan._tcp", "local."],
    ]);
  });

  it("is null when nothing is found", async () => {
    expect(await discoverScanner(async () => null)).toBeNull();
  });
});

describe("resolveScannerHost", () => {
  it("uses a cached host that answers, without browsing", async () => {
    const calls: string[][] = [];
    const { ports, written } = makePorts({
      cache: { host: "http://cached.local", at: 1 },
      dnsSd: fakeDnsSd(calls),
    });
    expect(await resolveScannerHost(ports)).toBe("http://cached.local");
    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it("discovers again once when the cached host is gone, and caches the new one", async () => {
    const { ports, written, probed } = makePorts({
      cache: { host: "http://cached.local", at: 1 },
      reachable: false,
    });
    expect(await resolveScannerHost(ports)).toBe("http://EXAMPLE1234.local");
    expect(probed).toEqual(["http://cached.local"]);
    expect(written).toEqual([{ host: "http://EXAMPLE1234.local", at: 99 }]);
  });

  it("discovers and caches without a cache", async () => {
    const { ports, written } = makePorts({});
    expect(await resolveScannerHost(ports)).toBe("http://EXAMPLE1234.local");
    expect(written).toHaveLength(1);
  });

  it("is null when discovery finds nothing", async () => {
    const { ports, written } = makePorts({ dnsSd: async () => null });
    expect(await resolveScannerHost(ports)).toBeNull();
    expect(written).toEqual([]);
  });
});
