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
import { readLastResult, readPending, readProgress } from "./pending";
import { CANCELLED_TRY_AGAIN } from "./runner";
import { submitRefusal } from "./pending-rules";
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
    // A distinct fake thumbnail per page; the real sips one is thumbs.ts.
    makeThumbs: async (paths) =>
      paths.map((_, i) => Uint8Array.of(i + 1, paths.length)),
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
    expect(readPending(stateDir)?.parts).toEqual(before?.parts);
  });

  it("leaves the pending scan as it was when the continuation is blank", async () => {
    await run();
    const before = readPending(stateDir);
    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pages = 2;
    clock += 10_000;
    const result = await runJob(opts("more"), deps(blank, 100));
    expect(result.message).toMatch(/^Scan stopped: all 2 pages look blank/);
    expect(readPending(stateDir)?.parts).toEqual(before?.parts);
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
    expect(readPending(stateDir)?.parts).toEqual(before?.parts);
  });
});

describe("a failed Scan More needs attention", () => {
  const blankMore = async () => {
    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pages = 3;
    clock += 10_000;
    return runJob(opts("more"), deps(blank, 100));
  };

  it("marks the pending scan when Scan More fails, in every way it can", async () => {
    await run("feeder", 5);
    expect(readPending(stateDir)?.attention).toBeUndefined();

    // blank
    const blanks = await blankMore();
    expect(readPending(stateDir)?.attention).toBe(blanks.message);

    // incomplete (the next successful more clears it, see below)
    await run("more", 1);
    expect(readPending(stateDir)?.attention).toBeUndefined();
    fake.state.pages = 5;
    fake.state.cancelAfter = 2;
    clock += 10_000;
    const cut = await runJob(opts("more"), deps());
    expect(readPending(stateDir)?.attention).toBe(cut.message);

    // cancelled by the device (feeder did not pick up the paper)
    await run("more", 1);
    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pickupFails = true;
    clock += 10_000;
    const cancelled = await runJob(opts("more"), deps());
    expect(cancelled.message).toBe(CANCELLED_TRY_AGAIN);
    expect(readPending(stateDir)?.attention).toBe(CANCELLED_TRY_AGAIN);

    // refused by the scanner
    await run("more", 1);
    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pickupFails = false;
    fake.state.failPosts = 100;
    clock += 10_000;
    const refused = await runJob(opts("more"), deps());
    expect(refused.ok).toBe(false);
    expect(readPending(stateDir)?.attention).toBe(refused.message);
  });

  it("is in --status, and the last result says what happened", async () => {
    await run("feeder", 5);
    const blanks = await blankMore();
    const status = scanStatus(opts(), deps());
    expect(status.pending).toMatchObject({
      needsAttention: true,
      attention: blanks.message,
    });
    expect(status.lastResult).toEqual({
      at: clock,
      action: "more",
      ok: false,
      message: blanks.message,
    });
  });

  it("refuses Submit after a failed more, with the message, and files nothing", async () => {
    await run("feeder", 5);
    const blanks = await blankMore();
    const refused = await submit();
    expect(refused).toEqual({
      ok: false,
      message: submitRefusal(blanks.message),
    });
    expect(refused.message).toMatch(
      /^The last Scan More failed: Scan stopped: all 3 pages look blank.*\. Scan those sheets again, or submit anyway$/,
    );
    expect(parts()).toHaveLength(1);
    expect(inboxFiles()).toEqual([]);
    expect(readLastResult(stateDir)).toMatchObject({
      action: "submit",
      ok: false,
      message: refused.message,
    });
  });

  it("files it with --force, and clears the mark", async () => {
    await run("feeder", 5);
    await blankMore();
    const forced = await submitNow({ ...opts(), force: true }, deps(), noop);
    expect(forced.ok).toBe(true);
    expect(inboxFiles()).toHaveLength(1);
    expect(pdfPages(join(inbox, inboxFiles()[0]))).toBe(5);
    expect(readPending(stateDir)).toBeNull();
    expect(readLastResult(stateDir)).toMatchObject({
      action: "submit",
      ok: true,
      pages: 5,
    });
  });

  it("is cleared by a successful Scan More", async () => {
    await run("feeder", 5);
    await blankMore();
    const ok = await run("more", 2);
    expect(ok.ok).toBe(true);
    expect(readPending(stateDir)?.attention).toBeUndefined();
    expect(scanStatus(opts(), deps()).pending?.needsAttention).toBe(false);
    expect((await submit()).ok).toBe(true);
    expect(pdfPages(join(inbox, inboxFiles()[0]))).toBe(7);
  });

  it("is cleared by Discard, and a new scan files the pending one without asking", async () => {
    await run("feeder", 3);
    await blankMore();
    expect((await discardPending(opts(), deps(), noop)).ok).toBe(true);
    expect(readPending(stateDir)).toBeNull();

    await run("feeder", 3);
    await blankMore();
    const next = await run("feeder", 2);
    expect(next.ok).toBe(true);
    expect(inboxFiles()).toHaveLength(1); // the first, filed by the new scan
    expect(parts()[0].pages).toBe(2);
    expect(readPending(stateDir)?.attention).toBeUndefined();
  });

  it("does not mark anything for a failed scan other than Scan More, or with nothing pending", async () => {
    fake.state.pickupFails = true;
    await runJob(opts(), deps());
    expect(readPending(stateDir)).toBeNull();
    const more = await runJob(opts("more"), deps());
    expect(more.message).toBe(
      "Nothing to continue (the last scan is already filed)",
    );
    expect(readPending(stateDir)).toBeNull();
    // the first still left its last result
    expect(readLastResult(stateDir)).toMatchObject({
      action: "more",
      ok: false,
    });
  });

  it("writes last-result.json for scan, submit and discard", async () => {
    await run("feeder", 3);
    expect(readLastResult(stateDir)).toEqual({
      at: clock,
      action: "feeder",
      ok: true,
      message: SCANNED_3,
      pages: 3,
    });
    expect((await submit()).ok).toBe(true);
    expect(readLastResult(stateDir)).toMatchObject({
      action: "submit",
      ok: true,
      pages: 3,
    });
    await run("feeder", 2);
    await discardPending(opts(), deps(), noop);
    expect(readLastResult(stateDir)).toMatchObject({
      action: "discard",
      ok: true,
      pages: 2,
    });
    expect(readLastResult(join(root, "nowhere"))).toBeNull();
  });
});

describe("a 200 that is not a JPEG while the scanner cancels the job", () => {
  it("is not a page: the first request ends in the cancel message, nothing pending, no temp dir", async () => {
    fake.state.junkPageAt = 1;
    const result = await runJob(opts(), deps());
    expect(result).toEqual({ ok: false, message: CANCELLED_TRY_AGAIN });
    expect(bodies()).toEqual([`Scan failed: ${CANCELLED_TRY_AGAIN}`]);
    expect(readPending(stateDir)).toBeNull();
    expect(tmpDirs()).toEqual([]);
    const log = readFileSync(join(stateDir, "scan.log"), "utf8");
    expect(log).toMatch(/page 1: not a JPEG, 26 bytes, starts 3c 68 74 6d 6c/);
    expect(log).not.toContain("Not a JPEG image");
    expect(log).not.toContain("temp dir kept");
  });

  it("after two good pages the batch is incomplete: partial/ holds the two pages", async () => {
    fake.state.pages = 5;
    fake.state.junkPageAt = 3;
    const result = await runJob(opts(), deps());
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(
      /^Scan stopped after 2 pages: the scanner cancelled the scan \(the feeder did not pick up the paper\)\. Partial PDF kept in /,
    );
    const [kept] = readdirSync(join(stateDir, "partial"));
    expect(pdfPages(join(stateDir, "partial", kept))).toBe(2);
    expect(readPending(stateDir)).toBeNull();
    expect(inboxFiles()).toEqual([]);
    expect(tmpDirs()).toEqual([]);
  });

  it("marks a pending scan when it happens in Scan More", async () => {
    await run("feeder", 3);
    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pages = 4;
    fake.state.junkPageAt = 1;
    clock += 10_000;
    const result = await runJob(opts("more"), deps());
    expect(result.message).toBe(CANCELLED_TRY_AGAIN);
    expect(readPending(stateDir)?.attention).toBe(CANCELLED_TRY_AGAIN);
    expect(parts()[0].pages).toBe(3);
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
  });

  it("gives every pending part its PDF path and a thumbnail path per page", async () => {
    await run("fronts");
    await run("backs", 2);
    const status = scanStatus(opts(), deps({}, 200));
    for (const p of status.pending!.parts) {
      expect(existsSync(p.pdfPath)).toBe(true);
      expect(p.pdfPath.endsWith("scan.pdf")).toBe(true);
      expect(p.thumbPaths).toHaveLength(p.pages);
      for (const t of p.thumbPaths) {
        expect(t).toMatch(/\/thumb-\d{3}-[0-9a-f]{8}\.jpg$/);
        expect(existsSync(t!)).toBe(true);
      }
    }
    expect(Object.keys(status.pending!.parts[0]).sort()).toEqual([
      "at",
      "fileName",
      "mode",
      "pagePaths",
      "pages",
      "pdfPath",
      "thumbPaths",
    ]);
  });

  it("adds thumbnails for the pages Scan More appends and keeps the fronts' ones", async () => {
    await run("fronts"); // 3 pages
    const before = scanStatus(opts(), deps()).pending!.parts[0].thumbPaths;
    await run("backs", 2);
    await run("more", 2);
    const parts = scanStatus(opts(), deps()).pending!.parts;
    expect(parts[0].thumbPaths).toEqual(before); // untouched content, same names
    expect(parts[1].pages).toBe(4);
    expect(parts[1].thumbPaths.every((t) => t !== null)).toBe(true);
    // the appended pages are page 3 and 4 of the backs
    expect(parts[1].thumbPaths[2]).toMatch(/thumb-003-/);
    expect(parts[1].thumbPaths[3]).toMatch(/thumb-004-/);
  });

  it("never fails a scan on a thumbnail: null for one that failed, all null when thumbs throw", async () => {
    const some = await runJob(
      opts(),
      deps({
        makeThumbs: async (paths) =>
          paths.map((_, i) => (i === 1 ? null : Uint8Array.of(i))),
      }),
    );
    expect(some.ok).toBe(true);
    const thumbs = scanStatus(opts(), deps()).pending!.parts[0].thumbPaths;
    expect(thumbs.map((t) => t !== null)).toEqual([true, false, true]);

    await discardPending(opts(), deps(), noop);
    fake.state.adfState = "ScannerAdfLoaded";
    clock += 10_000;
    const none = await runJob(
      opts(),
      deps({
        makeThumbs: async () => {
          throw new Error("sips is gone");
        },
      }),
    );
    expect(none.ok).toBe(true);
    expect(scanStatus(opts(), deps()).pending!.parts[0].thumbPaths).toEqual([
      null,
      null,
      null,
    ]);
    expect(readFileSync(join(stateDir, "scan.log"), "utf8")).toContain(
      "thumbs: failed",
    );
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
