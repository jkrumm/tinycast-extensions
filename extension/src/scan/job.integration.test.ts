// The whole job against the in-process fake scanner (fake-scanner.ts) with the
// REAL curl transport over 127.0.0.1 and real temp dirs. Several "processes"
// are played by giving each call its own pid. Never touches a real scanner:
// every test asserts its fake's URL is loopback.

import {
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { copyFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliverFs } from "./deliver";
import { FakeScanner, startFakeScanner } from "./fake-scanner";
import { discardPending, scanStatus, submitNow } from "./filing";
import { checkJob, JobDeps, JobOptions, runJob } from "./job";
import { readPending, readProgress } from "./pending";
import { CANCELLED_TRY_AGAIN } from "./runner";
import { curlScanHttp } from "./transport";

const T0 = new Date(2026, 10, 26, 18, 0, 0).getTime();

let fake: FakeScanner;
let root: string;
let inbox: string;
let stateDir: string;
let clock: number;
let notes: { title: string; body: string }[];
// A hook in the sleep a running scan takes between pages.
let onSleep: (() => void) | null;

const nodeFs: DeliverFs = {
  copyExclusive: (src, dest) => copyFile(src, dest, constants.COPYFILE_EXCL),
  size: async (path) => (await stat(path)).size,
  mkdirp: async (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  remove: async (path) => rmSync(path, { force: true }),
};

beforeEach(async () => {
  fake = await startFakeScanner();
  expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  root = mkdtempSync(join(tmpdir(), "scan-job-test-"));
  inbox = join(root, "inbox");
  stateDir = join(root, "state");
  mkdirSync(inbox);
  clock = T0;
  notes = [];
  onSleep = null;
});

afterEach(async () => {
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

const opts = (mode: JobOptions["mode"] = "feeder"): JobOptions => ({
  mode,
  outDir: inbox,
  host: fake.url,
  stateDir,
  notify: true,
});

// `pid`: the process this call plays; 100 and 200 are alive.
function deps(overrides: Partial<JobDeps> = {}, pid = 100): JobDeps {
  return {
    http: curlScanHttp,
    sleep: async (ms) => {
      clock += ms;
      onSleep?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
    now: () => clock,
    pid,
    isPidAlive: (p) => p === 100 || p === 200,
    resolveHost: async () => fake.url,
    notify: async (n) => {
      notes.push(n);
      return true;
    },
    deliverFs: nodeFs,
    tmpRoot: root,
    // The fake's JPEGs are not decodable: every page reads as inked unless a
    // test says otherwise (blank.test.ts and ink.test.ts cover the real thing).
    measureInk: async (paths) => paths.map(() => 0.05),
    ...overrides,
  };
}

const blank: Partial<JobDeps> = {
  measureInk: async (paths) => paths.map(() => 0),
};
const noop = (): void => undefined;
const run = (mode: JobOptions["mode"] = "feeder", pages?: number) => {
  fake.state.adfState = "ScannerAdfLoaded";
  fake.state.cancelAfter = null;
  fake.state.pickupFails = false;
  if (pages !== undefined) fake.state.pages = pages;
  clock += 10_000;
  return runJob(opts(mode), deps());
};
const pdfPages = (path: string): number =>
  readFileSync(path)
    .toString("latin1")
    .match(/\/Type \/Page\b/g)?.length ?? 0;
const inboxFiles = (): string[] =>
  readdirSync(inbox)
    .filter((f) => f.endsWith(".pdf"))
    .sort();
const tmpDirs = (): string[] =>
  readdirSync(root).filter((n) => /^scan-[A-Za-z0-9]{6}$/.test(n));
const bodies = (): string[] => notes.map((n) => n.body);
const parts = () => readPending(stateDir)?.parts ?? [];
const submit = (pid = 100) => submitNow(opts(), deps({}, pid), noop);

const SCANNED_3 =
  "3 pages scanned. Scan More to append, Submit Scan to file it.";

describe("a scan stays pending until it is submitted", () => {
  it("is kept locally, not filed, with no expiry", async () => {
    const result = await run();
    expect(result).toEqual({ ok: true, message: SCANNED_3 });
    expect(inboxFiles()).toEqual([]);
    expect(parts()).toMatchObject([{ mode: "feeder", pages: 3 }]);
    expect(existsSync(join(stateDir, "lock"))).toBe(false);
    expect(existsSync(join(stateDir, "progress.json"))).toBe(false);
    expect(tmpDirs()).toEqual([]);
    expect(bodies()).toEqual([SCANNED_3]);

    clock += 30 * 24 * 3600_000; // a month later
    expect(parts()).toHaveLength(1);
    expect(inboxFiles()).toEqual([]);
  });

  it("Submit Scan files it", async () => {
    await run();
    const result = await submit();
    const [name] = inboxFiles();
    expect(name).toMatch(/^scan-2026-11-26-1800\d\d\.pdf$/);
    expect(result).toEqual({ ok: true, message: `Filed: 3 pages -> ${name}` });
    expect(pdfPages(join(inbox, name))).toBe(3);
    expect(readPending(stateDir)).toBeNull();
  });

  it("Submit Scan says when nothing is pending, and keeps the scan when the inbox is missing", async () => {
    expect(await submit()).toEqual({ ok: false, message: "Nothing to submit" });
    await run();
    rmSync(inbox, { recursive: true });
    expect(await submit()).toEqual({
      ok: false,
      message: "Scan inbox not found (is the share mounted?)",
    });
    expect(parts()).toHaveLength(1);
  });

  it("Submit Scan keeps the PDF in unsent/ when the inbox copy fails", async () => {
    await run();
    const result = await submitNow(
      opts(),
      deps({
        deliverFs: {
          ...nodeFs,
          copyExclusive: async (src, dest) => {
            if (dest.startsWith(inbox)) throw new Error("share gone");
            await nodeFs.copyExclusive(src, dest);
          },
        },
      }),
      noop,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(
      /^Scanned 3 pages but the inbox is not reachable\. PDF kept in .*unsent$/,
    );
    expect(readdirSync(join(stateDir, "unsent"))).toHaveLength(1);
    expect(inboxFiles()).toEqual([]);
    expect(readPending(stateDir)).toBeNull();
  });

  it("files once when two submits race", async () => {
    await run();
    const [a, b] = await Promise.all([submit(100), submit(200)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(inboxFiles()).toHaveLength(1);
  });

  it("Discard Scan moves the PDF to discarded/, nothing is filed", async () => {
    await run();
    const name = parts()[0].fileName;
    expect(await discardPending(opts(), deps(), noop)).toEqual({
      ok: true,
      message: "Discarded 3 pages",
    });
    const [kept] = readdirSync(join(stateDir, "discarded"));
    expect(kept).toBe(name);
    expect(pdfPages(join(stateDir, "discarded", kept))).toBe(3);
    expect(readPending(stateDir)).toBeNull();
    expect(inboxFiles()).toEqual([]);
    expect(await discardPending(opts(), deps(), noop)).toEqual({
      ok: false,
      message: "Nothing to discard",
    });
    // and it cannot be continued
    expect((await checkJob(opts("more"), deps())).ok).toBe(false);
  });

  it("refuses Submit and Discard while a scan is running", async () => {
    await run();
    writeFileSync(join(stateDir, "lock"), "200");
    const running = { ok: false, message: "A scan is already running" };
    expect(await submit()).toEqual(running);
    expect(await discardPending(opts(), deps(), noop)).toEqual(running);
    expect(parts()).toHaveLength(1);
  });

  it("a scan that is not complete or is blank is not pending", async () => {
    fake.state.pages = 5;
    fake.state.cancelAfter = 2;
    const cut = await runJob(opts(), deps());
    expect(cut.ok).toBe(false);
    expect(readdirSync(join(stateDir, "partial"))).toHaveLength(1);

    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pages = 3;
    fake.state.cancelAfter = null;
    clock += 10_000;
    const blanks = await runJob(opts(), deps(blank));
    expect(blanks.message).toMatch(/^Scan stopped: all 3 pages look blank/);
    expect(readdirSync(join(stateDir, "blank"))).toHaveLength(1);
    expect(readPending(stateDir)).toBeNull();
  });

  it("tells the user to push the stack in when the feeder did not pick up the paper", async () => {
    fake.state.pickupFails = true;
    const result = await runJob(opts(), deps());
    expect(result).toEqual({ ok: false, message: CANCELLED_TRY_AGAIN });
    expect(bodies()).toEqual([`Scan failed: ${CANCELLED_TRY_AGAIN}`]);
    expect(readFileSync(join(stateDir, "scan.log"), "utf8")).toContain(
      "page 1: HTTP 410",
    );
    expect(readPending(stateDir)).toBeNull();
  });
});

describe("a new scan while one is pending", () => {
  it.each(["feeder", "fronts", "flatbed"] as const)(
    "%s files the pending scan first",
    async (mode) => {
      await run();
      const first = parts()[0].fileName;
      const result = await run(mode, 2);
      expect(inboxFiles()).toEqual([first]);
      expect(pdfPages(join(inbox, first))).toBe(3);
      // the first scan's notice, then Filed for it, then the new scan's
      expect(bodies()[0]).toBe(SCANNED_3);
      expect(bodies()[1]).toBe(`Filed: 3 pages -> ${first}`);
      expect(bodies()[2]).toBe(result.message);
      expect(parts()).toHaveLength(1);
      expect(parts()[0].pages).toBe(mode === "flatbed" ? 1 : 2);
    },
  );
});

describe("Scan More", () => {
  it("appends to the pending scan: one combined file once submitted", async () => {
    await run();
    const name = parts()[0].fileName;
    const result = await run("more", 2);
    expect(result).toEqual({ ok: true, message: "2 more pages, 5 in total." });
    expect(inboxFiles()).toEqual([]);
    expect(parts()).toMatchObject([{ fileName: name, pages: 5 }]);

    expect(await submit()).toEqual({
      ok: true,
      message: `Filed: 5 pages -> ${name}`,
    });
    expect(inboxFiles()).toEqual([name]);
    expect(pdfPages(join(inbox, name))).toBe(5);
  });

  it("can be repeated: 3 + 2 + 2 pages in one file", async () => {
    await run();
    await run("more", 2);
    const result = await run("more", 2);
    expect(result.message).toBe("2 more pages, 7 in total.");
    await submit();
    expect(inboxFiles()).toHaveLength(1);
    expect(pdfPages(join(inbox, inboxFiles()[0]))).toBe(7);
  });

  it("refuses before any scanner request when nothing is pending", async () => {
    const refused = {
      ok: false,
      message: "Nothing to continue (the last scan is already filed)",
    };
    expect(await checkJob(opts("more"), deps())).toEqual(refused);
    expect(await runJob(opts("more"), deps())).toEqual(refused);
    expect(bodies()).toEqual([
      "Scan failed: Nothing to continue (the last scan is already filed)",
    ]);
    expect(fake.state.requests).toHaveLength(0);

    await run();
    await submit();
    expect((await run("more", 2)).message).toBe(refused.message);
  });

  it("is allowed by the check while a scan is pending, at any age", async () => {
    await run();
    clock += 7 * 24 * 3600_000;
    fake.state.adfState = "ScannerAdfLoaded";
    expect(await checkJob(opts("more"), deps())).toEqual({ ok: true });
  });

  it("leaves the pending scan as it was when the feeder does not pick up (410)", async () => {
    await run();
    const before = readPending(stateDir);
    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pickupFails = true;
    clock += 10_000;
    const result = await runJob(opts("more"), deps());
    expect(result).toEqual({ ok: false, message: CANCELLED_TRY_AGAIN });
    expect(readPending(stateDir)).toEqual(before);
  });

  it("leaves the pending scan as it was when the continuation is blank", async () => {
    await run();
    const before = readPending(stateDir);
    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pages = 2;
    clock += 10_000;
    const result = await runJob(opts("more"), deps(blank, 100));
    expect(result.message).toMatch(/^Scan stopped: all 2 pages look blank/);
    expect(readPending(stateDir)).toEqual(before);
    expect(readdirSync(join(stateDir, "blank"))).toHaveLength(1);
  });

  it("puts an incomplete continuation in partial/ with only the new pages", async () => {
    await run();
    const before = readPending(stateDir);
    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pages = 5;
    fake.state.cancelAfter = 2;
    clock += 10_000;
    const result = await runJob(opts("more"), deps());
    expect(result.ok).toBe(false);
    const [partial] = readdirSync(join(stateDir, "partial"));
    expect(pdfPages(join(stateDir, "partial", partial))).toBe(2);
    expect(readPending(stateDir)).toEqual(before);
  });
});

describe("double-sided: fronts and backs stay together", () => {
  it("keeps both pending as a pair and files both files on Submit", async () => {
    const fronts = await run("fronts");
    expect(fronts.message).toBe(
      "3 pages scanned (fronts). Flip the stack, then Scan Backs.",
    );
    const vorne = parts()[0].fileName;
    expect(vorne).toMatch(/-vorne\.pdf$/);

    const backs = await run("backs", 2);
    expect(backs.message).toBe(
      "2 pages scanned (backs, fronts had 3). Submit Scan to file both.",
    );
    // the fronts were NOT filed first
    expect(inboxFiles()).toEqual([]);
    expect(parts().map((p) => p.mode)).toEqual(["fronts", "backs"]);
    const hinten = parts()[1].fileName;
    expect(hinten).toBe(vorne.replace("-vorne.pdf", "-hinten.pdf"));

    expect(await submit()).toEqual({
      ok: true,
      message: `Filed: 3 + 2 pages -> ${vorne}, ${hinten}`,
    });
    expect(inboxFiles()).toEqual([hinten, vorne].sort());
    expect(pdfPages(join(inbox, vorne))).toBe(3);
    expect(pdfPages(join(inbox, hinten))).toBe(2);
    expect(readPending(stateDir)).toBeNull();
  });

  it("backs of the same page count have no note", async () => {
    await run("fronts");
    const backs = await run("backs", 3);
    expect(backs.message).toBe(
      "3 pages scanned (backs). Submit Scan to file both.",
    );
  });

  it("refuses backs without pending fronts, and a second backs", async () => {
    const first = { ok: false, message: "Scan the fronts first" };
    expect(await checkJob(opts("backs"), deps())).toEqual(first);
    expect(await runJob(opts("backs"), deps())).toEqual(first);
    expect(fake.state.requests).toHaveLength(0);

    await run("feeder"); // pending, but not fronts
    expect((await checkJob(opts("backs"), deps())).ok).toBe(false);
    await discardPending(opts(), deps(), noop);

    await run("fronts");
    await run("backs", 2);
    const again = await checkJob(opts("backs"), deps());
    expect(again).toEqual({
      ok: false,
      message: "The backs are already scanned. Submit Scan files both",
    });
  });

  it("has no 30-minute pairing rule: the pending fronts are the pairing", async () => {
    await run("fronts");
    clock += 3 * 3600_000;
    fake.state.adfState = "ScannerAdfLoaded";
    expect(await checkJob(opts("backs"), deps())).toEqual({ ok: true });
  });

  it("appends Scan More to the part scanned last, and re-checks the fronts count", async () => {
    await run("fronts"); // 3
    await run("backs", 2);
    const more = await run("more", 1);
    expect(more.message).toBe("1 more page, 3 in total.");
    expect(parts().map((p) => p.pages)).toEqual([3, 3]);
    const again = await run("more", 1);
    expect(again.message).toBe("1 more page, 4 in total (fronts had 3).");
    expect(parts().map((p) => p.pages)).toEqual([3, 4]);
    await submit();
    const hinten = inboxFiles().find((f) => f.endsWith("-hinten.pdf"))!;
    const vorne = inboxFiles().find((f) => f.endsWith("-vorne.pdf"))!;
    expect(pdfPages(join(inbox, hinten))).toBe(4);
    expect(pdfPages(join(inbox, vorne))).toBe(3);
  });

  it("appends Scan More to the fronts when the backs are not scanned yet", async () => {
    await run("fronts");
    const more = await run("more", 2);
    expect(more.message).toBe("2 more pages, 5 in total.");
    expect(parts().map((p) => p.pages)).toEqual([5]);
    const backs = await run("backs", 5);
    expect(backs.message).toBe(
      "5 pages scanned (backs). Submit Scan to file both.",
    );
  });

  it("does not measure backs: blank backs are normal", async () => {
    await run("fronts");
    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pages = 2;
    const measured: string[][] = [];
    const result = await runJob(
      opts("backs"),
      deps({
        measureInk: async (paths) => {
          measured.push(paths);
          return paths.map(() => 0);
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(measured).toEqual([]);
  });

  it("Discard Scan drops both parts", async () => {
    await run("fronts");
    await run("backs", 2);
    expect(await discardPending(opts(), deps(), noop)).toEqual({
      ok: true,
      message: "Discarded 5 pages (fronts and backs)",
    });
    expect(readdirSync(join(stateDir, "discarded"))).toHaveLength(2);
    expect(inboxFiles()).toEqual([]);
    expect(readPending(stateDir)).toBeNull();
  });

  it("a new scan files both parts first", async () => {
    await run("fronts");
    await run("backs", 2);
    await run("feeder", 1);
    expect(inboxFiles()).toHaveLength(2);
    expect(bodies().some((b) => /^Filed: 3 \+ 2 pages -> /.test(b))).toBe(true);
    expect(parts()).toHaveLength(1);
    expect(parts()[0].mode).toBe("feeder");
  });
});

describe("--status", () => {
  it("is null when nothing is pending", () => {
    expect(scanStatus(opts(), deps())).toEqual({ pending: null });
  });

  it("describes the pending parts with the absolute paths of their pages", async () => {
    await run("fronts");
    await run("backs", 2);
    const status = scanStatus(opts(), deps({}, 200));
    expect(status.progress).toBeUndefined();
    expect(status.pending?.scanning).toBe(false);
    expect(status.pending?.parts.map((p) => [p.mode, p.pages])).toEqual([
      ["fronts", 3],
      ["backs", 2],
    ]);
    for (const p of status.pending!.parts) {
      expect(p.pagePaths).toHaveLength(p.pages);
      for (const path of p.pagePaths) {
        expect(path.startsWith("/")).toBe(true);
        expect(existsSync(path)).toBe(true);
      }
    }
    expect(Object.keys(status.pending!.parts[0]).sort()).toEqual([
      "at",
      "fileName",
      "mode",
      "pagePaths",
      "pages",
    ]);
  });

  it("reports the running scan's progress while the scan lock is held", async () => {
    await run();
    const seen: unknown[] = [];
    onSleep = () => {
      // played by another process: the status CLI
      seen.push(scanStatus(opts(), deps({}, 200)));
    };
    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pages = 3;
    clock += 10_000;
    await runJob(opts("more"), deps());
    expect(seen.length).toBeGreaterThan(0);
    const during = seen.at(-1) as ReturnType<typeof scanStatus>;
    expect(during.pending?.scanning).toBe(true);
    expect(during.progress).toMatchObject({
      mode: "more",
      pid: 100,
      page: expect.any(Number),
    });
    expect(during.progress!.page).toBeGreaterThanOrEqual(1);
    expect(during.progress!.startedAt).toBeGreaterThan(0);
    // removed at the end
    expect(readProgress(stateDir)).toBeNull();
    expect(scanStatus(opts(), deps({}, 200))).not.toHaveProperty("progress");
  });

  it("shows the progress of a first scan even when nothing is pending yet", async () => {
    const seen: ReturnType<typeof scanStatus>[] = [];
    onSleep = () => {
      seen.push(scanStatus(opts(), deps({}, 200)));
    };
    await runJob(opts(), deps());
    expect(seen.at(-1)).toMatchObject({
      pending: null,
      progress: { mode: "feeder" },
    });
  });

  it("ignores a progress file left by a scan that is gone", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "progress.json"),
      JSON.stringify({ mode: "feeder", page: 3, startedAt: 1, pid: 999999 }),
    );
    expect(scanStatus(opts(), deps())).toEqual({ pending: null });
  });
});

describe("the checks", () => {
  it("refuses while another scan runs, and a missing inbox", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "lock"), "200");
    expect(await checkJob(opts(), deps())).toEqual({
      ok: false,
      message: "A scan is already running",
    });
    expect(await runJob(opts(), deps())).toEqual({
      ok: false,
      message: "A scan is already running",
    });
    expect(readFileSync(join(stateDir, "lock"), "utf8")).toBe("200");
    expect(
      await checkJob({ ...opts(), outDir: join(root, "missing") }, deps()),
    ).toEqual({
      ok: false,
      message: "Scan inbox not found (is the share mounted?)",
    });
  });

  it("takes over a scan lock whose process is gone", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "lock"), "999999");
    expect((await runJob(opts(), deps())).ok).toBe(true);
  });

  it("does not notify with --no-notify", async () => {
    await runJob({ ...opts(), notify: false }, deps());
    expect(notes).toEqual([]);
    expect(parts()).toHaveLength(1);
  });
});
