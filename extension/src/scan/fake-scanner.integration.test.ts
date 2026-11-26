// Integration suite against the in-process fake scanner (fake-scanner.ts)
// using the REAL curl transport over 127.0.0.1 — the closest thing to the
// device that is safe to run in `make check`. Never touches a real scanner:
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
import { findJob, parseScannerStatus } from "./escl";
import { FakeScanner, startFakeScanner } from "./fake-scanner";
import { JobDeps, JobOptions, checkJob, runJob } from "./job";
import { jpegsToPdf } from "./pdf";
import { runScan, ScanPorts } from "./runner";
import { curlScanHttp } from "./transport";
import { DeliverFs } from "./deliver";

let fake: FakeScanner;
let root: string;

const fastSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)));

beforeEach(async () => {
  fake = await startFakeScanner();
  expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  root = mkdtempSync(join(tmpdir(), "fake-scanner-test-"));
});

afterEach(async () => {
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

function ports(): ScanPorts {
  return {
    http: curlScanHttp,
    sleep: fastSleep,
    now: Date.now,
    pagePath: (i) => join(root, `page-${i}.jpg`),
    readFile: async (path) => new Uint8Array(readFileSync(path)),
    log: () => undefined,
  };
}

const pdfPages = (pdf: Uint8Array): number =>
  Buffer.from(pdf)
    .toString("latin1")
    .match(/\/Type \/Page\b/g)?.length ?? 0;

describe("curl transport + runner + PDF against the fake scanner", () => {
  it("scans three pages into a three-page PDF", async () => {
    const result = await runScan(ports(), { host: fake.url, mode: "feeder" });
    expect(result.complete).toBe(true);
    expect(result.pages).toHaveLength(3);
    const pdf = jpegsToPdf(result.pages.map((jpeg) => ({ jpeg, dpi: 300 })));
    expect(pdfPages(pdf)).toBe(3);

    const post = fake.state.requests.find((r) => r.method === "POST");
    expect(post?.contentType).toBe("application/xml");
    expect(fake.state.settings).toContain("<pwg:Width>2480</pwg:Width>");
    expect(fake.state.deleted).toBe(1);
  });

  it("gets through the Brother early-404 quirk without losing a page", async () => {
    fake.state.minPageGapMs = 40;
    const result = await runScan(ports(), { host: fake.url, mode: "feeder" });
    expect(result.pages).toHaveLength(3);
    expect(result.complete).toBe(true);
  });

  it("retries a 503 on the job creation and on a page", async () => {
    fake.state.failPosts = 2;
    fake.state.failNextDocuments = 2;
    const result = await runScan(ports(), { host: fake.url, mode: "feeder" });
    expect(result.pages).toHaveLength(3);
  });

  it("keeps the pages of a batch cancelled at the scanner", async () => {
    fake.state.pages = 5;
    fake.state.cancelAfter = 2;
    const result = await runScan(ports(), { host: fake.url, mode: "feeder" });
    expect(result.pages).toHaveLength(2);
    expect(result).toMatchObject({
      complete: false,
      reason: "cancelled at the scanner",
    });
    expect(fake.state.deleted).toBe(1);
  });

  it("reads Processing and an empty feeder while the job runs, with the job unlisted until it ends", async () => {
    const readStatus = async () =>
      parseScannerStatus(
        (await curlScanHttp.get(`${fake.url}/eSCL/ScannerStatus`, 5)).body,
      );
    expect(await readStatus()).toMatchObject({
      state: "Idle",
      adfState: "ScannerAdfLoaded",
    });

    const post = await curlScanHttp.post(
      `${fake.url}/eSCL/ScanJobs`,
      "application/xml",
      "<x/>",
      5,
    );
    expect(post.status).toBe(201);
    const running = await readStatus();
    expect(running).toMatchObject({
      state: "Processing",
      adfState: "ScannerAdfEmpty",
    });
    expect(findJob(running, post.location!)).toBeNull();

    for (let page = 0; page < 3; page++) {
      const res = await curlScanHttp.download(
        `${post.location}/NextDocument`,
        join(root, `p${page}.jpg`),
        5,
      );
      expect(res.status).toBe(200);
    }
    const finished = await readStatus();
    expect(finished.state).toBe("Idle");
    expect(findJob(finished, post.location!)).toMatchObject({
      state: "Completed",
      imagesCompleted: 3,
    });
    // the record stays after DELETE
    await curlScanHttp.del(post.location!);
    expect(findJob(await readStatus(), post.location!)).not.toBeNull();
  });

  it("keeps the pages before a page that fails for good", async () => {
    fake.state.failPageAt = 3;
    const result = await runScan(ports(), { host: fake.url, mode: "feeder" });
    expect(result.pages).toHaveLength(2);
    expect(result.reason).toBe("page 3 failed (HTTP 500)");
    expect(fake.state.deleted).toBe(1);
  });

  it("refuses an empty feeder before creating a job", async () => {
    fake.state.adfState = "ScannerAdfEmpty";
    await expect(
      runScan(ports(), { host: fake.url, mode: "feeder" }),
    ).rejects.toThrow("No document in the feeder");
    expect(fake.state.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("scans one page from the flatbed", async () => {
    fake.state.adfState = "ScannerAdfEmpty";
    const result = await runScan(ports(), { host: fake.url, mode: "flatbed" });
    expect(result.pages).toHaveLength(1);
    expect(fake.state.settings).toContain(
      "<pwg:InputSource>Platen</pwg:InputSource>",
    );
  });

  it("reports an unreachable scanner as status 0", async () => {
    const dead = await startFakeScanner();
    const url = dead.url;
    await dead.close();
    expect(await curlScanHttp.get(`${url}/eSCL/ScannerStatus`, 2)).toEqual({
      status: 0,
      body: "",
    });
  });
});

describe("the whole job against the fake scanner", () => {
  let inbox: string;
  let stateDir: string;

  beforeEach(() => {
    inbox = join(root, "inbox");
    stateDir = join(root, "state");
    mkdirSync(inbox);
  });

  const opts = (mode: JobOptions["mode"] = "feeder"): JobOptions => ({
    mode,
    outDir: inbox,
    host: fake.url,
    stateDir,
    notify: true,
  });

  function deps(overrides: Partial<JobDeps> = {}): JobDeps & {
    notes: { title: string; body: string }[];
  } {
    const notes: { title: string; body: string }[] = [];
    return {
      http: curlScanHttp,
      sleep: fastSleep,
      now: Date.now,
      pid: process.pid,
      isPidAlive: () => false,
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
      notes,
      ...overrides,
    };
  }

  // The real fs through the same ports the CLI uses.
  const nodeFs: DeliverFs = {
    copyExclusive: (src, dest) => copyFile(src, dest, constants.COPYFILE_EXCL),
    size: async (path) => (await stat(path)).size,
    mkdirp: async (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    remove: async (path) => rmSync(path, { force: true }),
  };

  const tmpDirs = (): string[] =>
    readdirSync(root).filter((name) => name.startsWith("scan-"));

  it("files one PDF in the inbox, notifies, logs and cleans up", async () => {
    const d = deps();
    const result = await runJob(opts(), d);
    expect(result.ok).toBe(true);
    const files = readdirSync(inbox);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^scan-\d{4}-\d\d-\d\d-\d{6}\.pdf$/);
    expect(pdfPages(new Uint8Array(readFileSync(join(inbox, files[0]))))).toBe(
      3,
    );
    expect(d.notes).toEqual([
      { title: "Scan", body: `3 pages -> ${files[0]}` },
    ]);
    expect(tmpDirs()).toEqual([]);
    expect(existsSync(join(stateDir, "lock"))).toBe(false);
    const log = readFileSync(join(stateDir, "scan.log"), "utf8");
    expect(log).toContain("page 3:");
    expect(log).toContain(
      "final: state=Idle adf=ScannerAdfEmpty job=Completed imagesCompleted=3 received=3",
    );
  });

  it("pairs fronts and backs through last-fronts.json", async () => {
    expect((await runJob(opts("fronts"), deps())).ok).toBe(true);
    const [fronts] = readdirSync(inbox);
    expect(fronts).toMatch(/-vorne\.pdf$/);
    const last = JSON.parse(
      readFileSync(join(stateDir, "last-fronts.json"), "utf8"),
    );
    expect(last.stem).toBe(fronts.replace("-vorne.pdf", ""));
    expect(last.pages).toBe(3);

    fake.state.adfState = "ScannerAdfLoaded";
    expect((await runJob(opts("backs"), deps())).ok).toBe(true);
    expect(readdirSync(inbox).sort()).toEqual([
      `${last.stem}-hinten.pdf`,
      fronts,
    ]);
    expect(existsSync(join(stateDir, "last-fronts.json"))).toBe(false);
  });

  it("tells the user to flip the stack after a fronts scan", async () => {
    const result = await runJob(opts("fronts"), deps());
    const [fronts] = readdirSync(inbox);
    expect(result).toEqual({
      ok: true,
      message: `3 pages -> ${fronts}. Flip the stack, then Scan Backs`,
    });
  });

  it("notes a backs page count that differs from the fronts, and still delivers", async () => {
    await runJob(opts("fronts"), deps());
    fake.state.adfState = "ScannerAdfLoaded";
    fake.state.pages = 2;
    const d = deps();
    const result = await runJob(opts("backs"), d);
    const hinten = readdirSync(inbox).find((f) => f.endsWith("-hinten.pdf"));
    expect(hinten).toBeDefined();
    expect(result).toEqual({
      ok: true,
      message: `2 pages -> ${hinten} (fronts had 3)`,
    });
    expect(d.notes[0].body).toBe(`2 pages -> ${hinten} (fronts had 3)`);
  });

  it("does not compare page counts against a last-fronts.json without pages", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "last-fronts.json"),
      JSON.stringify({ stem: "scan-x", at: Date.now() }),
    );
    expect(await runJob(opts("backs"), deps())).toEqual({
      ok: true,
      message: "3 pages -> scan-x-hinten.pdf",
    });
  });

  describe("blank-batch guard", () => {
    const blank = async (paths: string[]) => paths.map(() => 0);

    it("keeps an all-blank batch out of the inbox, in blank/", async () => {
      const d = deps({ measureInk: blank });
      const result = await runJob(opts(), d);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(
        /^Scan stopped: all 3 pages look blank\. Stack upside down\? PDF kept in .*blank$/,
      );
      expect(d.notes[0].body).toBe(result.message);
      expect(readdirSync(inbox)).toEqual([]);
      expect(readdirSync(join(stateDir, "blank"))).toHaveLength(1);
      expect(tmpDirs()).toEqual([]);
      const log = readFileSync(join(stateDir, "scan.log"), "utf8");
      expect(log).toContain(
        "ink: min=0.000% median=0.000% max=0.000% blank=3/3",
      );
    });

    it("does not record fronts that look blank", async () => {
      const result = await runJob(opts("fronts"), deps({ measureInk: blank }));
      expect(result.ok).toBe(false);
      expect(readdirSync(join(stateDir, "blank"))[0]).toMatch(/-vorne\.pdf$/);
      expect(existsSync(join(stateDir, "last-fronts.json"))).toBe(false);
    });

    it("delivers a batch with at least one inked page", async () => {
      const d = deps({ measureInk: async () => [0, 0.02, 0] });
      expect((await runJob(opts(), d)).ok).toBe(true);
      expect(readdirSync(inbox)).toHaveLength(1);
      expect(existsSync(join(stateDir, "blank"))).toBe(false);
      expect(readFileSync(join(stateDir, "scan.log"), "utf8")).toContain(
        "ink: min=0.000% median=0.000% max=2.000% blank=2/3",
      );
    });

    it("never blocks on a page it could not measure", async () => {
      const d = deps({ measureInk: async () => [0, null, 0] });
      expect((await runJob(opts(), d)).ok).toBe(true);
      expect(readdirSync(inbox)).toHaveLength(1);
    });

    it("never blocks when measuring throws", async () => {
      const d = deps({
        measureInk: async () => {
          throw new Error("sips exploded");
        },
      });
      expect((await runJob(opts(), d)).ok).toBe(true);
      expect(readFileSync(join(stateDir, "scan.log"), "utf8")).toContain(
        "ink: measuring failed",
      );
    });

    it("does not measure backs (blank backs are normal), the flatbed or an incomplete batch", async () => {
      const measured: string[][] = [];
      const spy = async (paths: string[]) => {
        measured.push(paths);
        return paths.map(() => 0);
      };

      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "last-fronts.json"),
        JSON.stringify({ stem: "scan-x", at: Date.now(), pages: 3 }),
      );
      expect((await runJob(opts("backs"), deps({ measureInk: spy }))).ok).toBe(
        true,
      );

      fake.state.adfState = "ScannerAdfEmpty";
      expect(
        (await runJob(opts("flatbed"), deps({ measureInk: spy }))).ok,
      ).toBe(true);

      fake.state.adfState = "ScannerAdfLoaded";
      fake.state.pages = 5;
      fake.state.cancelAfter = 2;
      expect((await runJob(opts(), deps({ measureInk: spy }))).ok).toBe(false);

      expect(measured).toEqual([]);
    });
  });

  it("asks for the fronts first, and for a stale pairing", async () => {
    expect(await checkJob(opts("backs"), deps())).toEqual({
      ok: false,
      message: "Scan the fronts first",
    });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "last-fronts.json"),
      JSON.stringify({ stem: "scan-x", at: Date.now() - 31 * 60 * 1000 }),
    );
    expect((await checkJob(opts("backs"), deps())).ok).toBe(false);
    writeFileSync(
      join(stateDir, "last-fronts.json"),
      JSON.stringify({ stem: "scan-x", at: Date.now() - 5 * 60 * 1000 }),
    );
    expect(await checkJob(opts("backs"), deps())).toEqual({ ok: true });
  });

  it("checks inbox, lock and scanner without scanning", async () => {
    expect(await checkJob(opts(), deps())).toEqual({ ok: true });
    expect(fake.state.requests.some((r) => r.method === "POST")).toBe(false);

    expect(
      await checkJob({ ...opts(), outDir: join(root, "missing") }, deps()),
    ).toEqual({
      ok: false,
      message: "Scan inbox not found (is the share mounted?)",
    });

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "lock"), "999999");
    expect(await checkJob(opts(), deps({ isPidAlive: () => true }))).toEqual({
      ok: false,
      message: "A scan is already running",
    });
    // a lock whose pid is gone is taken over
    expect(await checkJob(opts(), deps({ isPidAlive: () => false }))).toEqual({
      ok: true,
    });
  });

  it("does not run while another scan holds the lock, and leaves its lock alone", async () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "lock"), "999999");
    const d = deps({ isPidAlive: () => true });
    const result = await runJob(opts(), d);
    expect(result).toEqual({ ok: false, message: "A scan is already running" });
    expect(readFileSync(join(stateDir, "lock"), "utf8")).toBe("999999");
    expect(fake.state.requests).toHaveLength(0);
  });

  it("keeps a batch cancelled at the scanner out of the inbox, as a partial PDF", async () => {
    fake.state.pages = 5;
    fake.state.cancelAfter = 2;
    const d = deps();
    const result = await runJob(opts("fronts"), d);
    expect(result.ok).toBe(false);
    expect(readdirSync(inbox)).toEqual([]);
    const partial = readdirSync(join(stateDir, "partial"));
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatch(/-vorne\.pdf$/);
    expect(d.notes[0].body).toMatch(
      /^Scan stopped after 2 pages: cancelled at the scanner\. Partial PDF kept in .*partial$/,
    );
    expect(existsSync(join(stateDir, "last-fronts.json"))).toBe(false);
    expect(tmpDirs()).toEqual([]);
  });

  it("keeps a finished scan in unsent when the inbox copy fails", async () => {
    const d = deps({
      deliverFs: {
        ...nodeFs,
        copyExclusive: async (src, dest) => {
          if (dest.startsWith(inbox)) throw new Error("share gone");
          await nodeFs.copyExclusive(src, dest);
        },
      },
    });
    const result = await runJob(opts("fronts"), d);
    expect(result.ok).toBe(false);
    expect(readdirSync(inbox)).toEqual([]);
    expect(readdirSync(join(stateDir, "unsent"))).toHaveLength(1);
    expect(d.notes[0].body).toMatch(
      /^Scanned 3 pages but the inbox is not reachable\. PDF kept in .*unsent$/,
    );
    expect(tmpDirs()).toEqual([]);
    // the fronts scan itself is done, so the pairing is recorded
    expect(existsSync(join(stateDir, "last-fronts.json"))).toBe(true);
  });

  it("reports a refused scan and cleans up", async () => {
    fake.state.adfState = "ScannerAdfEmpty";
    const d = deps();
    const result = await runJob(opts(), d);
    expect(result).toEqual({ ok: false, message: "No document in the feeder" });
    expect(d.notes[0].body).toBe("Scan failed: No document in the feeder");
    expect(tmpDirs()).toEqual([]);
    expect(existsSync(join(stateDir, "lock"))).toBe(false);
  });

  it("does not notify with --no-notify", async () => {
    const d = deps();
    await runJob({ ...opts(), notify: false }, d);
    expect(d.notes).toEqual([]);
  });

  describe("Scan More", () => {
    const T0 = new Date(2026, 10, 26, 18, 0, 0).getTime();
    let clockMs = T0;
    const at = (minutes: number, seconds = 0): number =>
      (clockMs = T0 + minutes * 60_000 + seconds * 1000);
    const run = (mode: JobOptions["mode"], overrides: Partial<JobDeps> = {}) =>
      runJob(opts(mode), deps({ now: () => clockMs, ...overrides }));
    const reload = (pages: number): void => {
      fake.state.adfState = "ScannerAdfLoaded";
      fake.state.pages = pages;
    };
    const inboxPages = (name: string): number =>
      pdfPages(new Uint8Array(readFileSync(join(inbox, name))));
    const readJson = (name: string) =>
      JSON.parse(readFileSync(join(stateDir, name), "utf8"));
    const keptPages = (): string[] =>
      readdirSync(join(stateDir, "last-pages")).sort();

    beforeEach(() => {
      clockMs = T0;
    });

    it("remembers every delivered scan for a later more", async () => {
      await run("feeder");
      const [name] = readdirSync(inbox);
      expect(readJson("last-scan.json")).toEqual({
        mode: "feeder",
        fileName: name,
        path: join(inbox, name),
        pages: 3,
        at: T0,
      });
      expect(keptPages()).toEqual([
        "page-001.jpg",
        "page-002.jpg",
        "page-003.jpg",
      ]);
    });

    it("appends to the file under its own name: one PDF, no second file", async () => {
      await run("feeder");
      const [name] = readdirSync(inbox);
      reload(2);
      const d = deps({ now: () => at(5) });
      const result = await runJob(opts("more"), d);
      expect(result).toEqual({
        ok: true,
        message: `2 more pages, 5 in total -> ${name}`,
      });
      expect(readdirSync(inbox)).toEqual([name]);
      expect(inboxPages(name)).toBe(5);
      expect(d.notes[0].body).toBe(`2 more pages, 5 in total -> ${name}`);
      expect(readJson("last-scan.json")).toMatchObject({
        mode: "feeder",
        fileName: name,
        pages: 5,
        at: at(5),
      });
      expect(keptPages()).toHaveLength(5);
      expect(tmpDirs()).toEqual([]);
    });

    it("can be repeated: 3 + 2 + 2 pages", async () => {
      await run("feeder");
      const [name] = readdirSync(inbox);
      reload(2);
      await run("more");
      at(10);
      reload(2);
      const result = await run("more");
      expect(result).toEqual({
        ok: true,
        message: `2 more pages, 7 in total -> ${name}`,
      });
      expect(readdirSync(inbox)).toEqual([name]);
      expect(inboxPages(name)).toBe(7);
      expect(keptPages()).toHaveLength(7);
    });

    it("files the new pages on their own when the first file was already picked up", async () => {
      await run("feeder");
      const [first] = readdirSync(inbox);
      rmSync(join(inbox, first));
      reload(2);
      at(2);
      const result = await run("more");
      const [second] = readdirSync(inbox);
      expect(second).not.toBe(first);
      expect(result).toEqual({
        ok: true,
        message: `2 pages -> ${second} (the first part was already picked up)`,
      });
      expect(inboxPages(second)).toBe(2);
      expect(readJson("last-scan.json")).toMatchObject({
        mode: "feeder",
        fileName: second,
        pages: 2,
      });
      expect(keptPages()).toHaveLength(2);
    });

    it("files the new pages on their own while the consumer's lock exists", async () => {
      await run("feeder");
      const [first] = readdirSync(inbox);
      writeFileSync(join(inbox, ".fin-inbox.lock"), "");
      reload(2);
      at(2);
      const result = await run("more");
      const files = readdirSync(inbox).filter((f) => f.endsWith(".pdf"));
      expect(files).toHaveLength(2);
      const second = files.find((f) => f !== first)!;
      expect(inboxPages(first)).toBe(3);
      expect(inboxPages(second)).toBe(2);
      expect(result).toEqual({
        ok: true,
        message: `2 pages -> ${second} (the first part was already picked up)`,
      });
    });

    it("falls back to a separate file when the old one cannot be removed", async () => {
      await run("feeder");
      const [first] = readdirSync(inbox);
      reload(2);
      at(2);
      const result = await run("more", {
        deliverFs: {
          ...nodeFs,
          remove: async (path) => {
            if (path.startsWith(inbox)) throw new Error("permission denied");
            rmSync(path, { force: true });
          },
        },
      });
      expect(result.ok).toBe(true);
      expect(result.message).toContain(
        "(the first part could not be replaced)",
      );
      expect(inboxPages(first)).toBe(3);
      expect(readdirSync(inbox)).toHaveLength(2);
    });

    it("refuses before any scanner request when there is nothing to continue", async () => {
      const d = deps({ now: () => clockMs });
      expect(await runJob(opts("more"), d)).toEqual({
        ok: false,
        message: "Nothing to continue",
      });
      expect(d.notes[0].body).toBe("Scan failed: Nothing to continue");
      expect(fake.state.requests).toHaveLength(0);
      expect(await checkJob(opts("more"), d)).toEqual({
        ok: false,
        message: "Nothing to continue",
      });
      expect(fake.state.requests).toHaveLength(0);
    });

    it("refuses a last scan older than 30 minutes, and a kept-pages count that does not match", async () => {
      await run("feeder");
      reload(2);
      at(31);
      expect(await run("more")).toEqual({
        ok: false,
        message: "Nothing to continue (the last scan is older than 30 minutes)",
      });
      at(5);
      rmSync(join(stateDir, "last-pages", "page-003.jpg"));
      expect(await run("more")).toEqual({
        ok: false,
        message: "Nothing to continue",
      });
      expect(
        fake.state.requests.filter((r) => r.method === "POST"),
      ).toHaveLength(1);
    });

    it("leaves the inbox file and the kept scan alone after a blank batch", async () => {
      await run("feeder");
      const [name] = readdirSync(inbox);
      const before = readFileSync(join(inbox, name));
      reload(2);
      at(2);
      const result = await run("more", {
        measureInk: async (paths) => paths.map(() => 0),
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/^Scan stopped: all 2 pages look blank/);
      expect(readFileSync(join(inbox, name)).equals(before)).toBe(true);
      expect(readdirSync(inbox)).toEqual([name]);
      expect(readdirSync(join(stateDir, "blank"))).toHaveLength(1);
      expect(readJson("last-scan.json")).toMatchObject({ pages: 3, at: T0 });
      expect(keptPages()).toHaveLength(3);
    });

    it("keeps an incomplete continuation as a partial with only the new pages", async () => {
      await run("feeder");
      const [name] = readdirSync(inbox);
      reload(5);
      fake.state.cancelAfter = 2;
      at(2);
      const result = await run("more");
      expect(result.ok).toBe(false);
      expect(inboxPages(name)).toBe(3);
      expect(readdirSync(join(stateDir, "partial"))).toHaveLength(1);
      expect(readJson("last-scan.json")).toMatchObject({ pages: 3 });
    });

    it("keeps the combined PDF in unsent when the inbox copy fails, and the old state", async () => {
      await run("feeder");
      const [name] = readdirSync(inbox);
      reload(2);
      at(2);
      const result = await run("more", {
        deliverFs: {
          ...nodeFs,
          copyExclusive: async (src, dest) => {
            if (dest.startsWith(inbox)) throw new Error("share gone");
            await nodeFs.copyExclusive(src, dest);
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(
        /^Scanned 5 pages but the inbox is not reachable/,
      );
      const [kept] = readdirSync(join(stateDir, "unsent"));
      expect(kept).toBe(name);
      expect(
        pdfPages(new Uint8Array(readFileSync(join(stateDir, "unsent", kept)))),
      ).toBe(5);
      expect(readJson("last-scan.json")).toMatchObject({ pages: 3, at: T0 });
    });

    it("keeps updating the fronts pairing when fronts are continued", async () => {
      await run("fronts");
      reload(2);
      at(2);
      await run("more");
      expect(readJson("last-fronts.json").pages).toBe(5);
      expect(readJson("last-scan.json")).toMatchObject({
        mode: "fronts",
        pages: 5,
      });

      reload(5);
      at(4);
      const backs = await run("backs");
      expect(backs.message).not.toContain("fronts had");
    });

    it("re-checks a continued backs scan against the fronts count", async () => {
      await run("fronts"); // 3 pages
      reload(2);
      at(2);
      const backs = await run("backs");
      expect(backs.message).toMatch(/\(fronts had 3\)$/);
      const [hinten] = readdirSync(inbox).filter((f) =>
        f.endsWith("-hinten.pdf"),
      );
      expect(readJson("last-scan.json")).toMatchObject({
        mode: "backs",
        frontsPages: 3,
      });

      reload(1);
      at(3);
      expect(await run("more")).toEqual({
        ok: true,
        message: `1 more page, 3 in total -> ${hinten}`,
      });
      reload(1);
      at(4);
      expect(await run("more")).toEqual({
        ok: true,
        message: `1 more page, 4 in total -> ${hinten} (fronts had 3)`,
      });
      expect(inboxPages(hinten)).toBe(4);
    });
  });
});
