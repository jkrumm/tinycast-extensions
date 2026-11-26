import { describe, expect, it } from "vitest";
import { ScanMode } from "./escl";
import { syntheticJpeg } from "./fixtures";
import {
  BUSY_RETRIES,
  CANCELLED_TRY_AGAIN,
  FEEDER_CANCELLED,
  adfProblem,
  checkScanner,
  runScan,
  ScanError,
  ScanPorts,
  SCAN_DEADLINE_MS,
} from "./runner";

type JobSpec = { state: string; images?: number; reason?: string };
type StatusSpec =
  { state?: string; adf?: string | null; job?: JobSpec } | "unreachable";
type PostSpec = { status: number; location?: string | null };
type NextSpec = { status: number; ms?: number } | "throw";

// A scripted device: each queue is consumed in order; the last status repeats,
// an empty POST queue answers 201, an empty NextDocument queue answers 404.
const jobXml = (uri: string, job: JobSpec): string =>
  `<scan:JobInfo><pwg:JobUri>${uri}</pwg:JobUri>${
    job.images === undefined
      ? ""
      : `<pwg:ImagesCompleted>${job.images}</pwg:ImagesCompleted>`
  }<pwg:JobState>${job.state}</pwg:JobState>${
    job.reason
      ? `<pwg:JobStateReasons><pwg:JobStateReason>${job.reason}</pwg:JobStateReason></pwg:JobStateReasons>`
      : ""
  }</scan:JobInfo>`;

function makeDevice(opts: {
  statuses?: StatusSpec[];
  posts?: PostSpec[];
  nexts?: NextSpec[];
}) {
  const statuses = [
    ...(opts.statuses ?? [{ state: "Idle", adf: "ScannerAdfEmpty" }]),
  ];
  const posts = [...(opts.posts ?? [])];
  const nexts = [...(opts.nexts ?? [])];
  const calls: string[] = [];
  const posted: { url: string; contentType: string; body: string }[] = [];
  const sleeps: number[] = [];
  const downloadTimeouts: number[] = [];
  const logs: string[] = [];
  const files = new Map<string, Uint8Array>();
  let clock = 0;
  let pageNo = 0;

  const ports: ScanPorts = {
    http: {
      async get(url) {
        calls.push(`GET ${url}`);
        const spec = statuses.length > 1 ? statuses.shift()! : statuses[0];
        if (spec === "unreachable") return { status: 0, body: "" };
        const adf = spec.adf === undefined ? "ScannerAdfLoaded" : spec.adf;
        // An older, unrelated job is always listed; ours only when the spec says so.
        const jobs = [
          jobXml("/eSCL/ScanJobs/older", { state: "Completed", images: 9 }),
          spec.job ? jobXml("/eSCL/ScanJobs/1", spec.job) : "",
        ].join("");
        return {
          status: 200,
          body: `<pwg:State>${spec.state ?? "Idle"}</pwg:State>${
            adf ? `<scan:AdfState>${adf}</scan:AdfState>` : ""
          }<scan:Jobs>${jobs}</scan:Jobs>`,
        };
      },
      async post(url, contentType, body) {
        calls.push(`POST ${url}`);
        posted.push({ url, contentType, body });
        const spec = posts.shift() ?? { status: 201 };
        const location =
          spec.location === undefined ? "/eSCL/ScanJobs/1" : spec.location;
        return { status: spec.status, location };
      },
      async download(url, destPath, timeoutS) {
        calls.push(`GET ${url}`);
        downloadTimeouts.push(timeoutS);
        const spec = nexts.shift() ?? { status: 404 };
        if (spec === "throw") throw new Error("curl exploded");
        const ms = spec.ms ?? 10;
        clock += ms;
        if (spec.status === 200) {
          files.set(
            destPath,
            syntheticJpeg({ width: 100 + ++pageNo, height: 50 }),
          );
        }
        return { status: spec.status, ms };
      },
      async del(url) {
        calls.push(`DELETE ${url}`);
      },
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    pagePath: (i) => `/tmp/page-${i}.jpg`,
    readFile: async (path) => files.get(path)!,
    log: (line) => logs.push(line),
  };
  return { ports, calls, posted, sleeps, downloadTimeouts, logs };
}

const HOST = "http://scanner.test";
const NEXT = `GET ${HOST}/eSCL/ScanJobs/1/NextDocument`;
const feeder = (mode: ScanMode = "feeder") => ({ host: HOST, mode });
const loaded: StatusSpec = { state: "Idle", adf: "ScannerAdfLoaded" };
const empty: StatusSpec = { state: "Idle", adf: "ScannerAdfEmpty" };
// What the real device reads while a job runs: busy, feeder "empty", job unlisted.
const running: StatusSpec = { state: "Processing", adf: "ScannerAdfEmpty" };
const done = (images: number): StatusSpec => ({
  state: "Idle",
  adf: "ScannerAdfEmpty",
  job: { state: "Completed", images, reason: "JobCompletedSuccessfully" },
});

describe("checkScanner", () => {
  it("accepts an idle scanner with paper in the feeder", async () => {
    const { ports } = makeDevice({ statuses: [loaded] });
    expect(await checkScanner(ports, feeder())).toEqual({ ok: true });
  });

  it("reports an unreachable, a busy and an empty scanner", async () => {
    expect(
      await checkScanner(
        makeDevice({ statuses: ["unreachable"] }).ports,
        feeder(),
      ),
    ).toEqual({ ok: false, message: "Scanner not reachable" });
    expect(
      await checkScanner(
        makeDevice({
          statuses: [{ state: "Processing", adf: "ScannerAdfLoaded" }],
        }).ports,
        feeder(),
      ),
    ).toEqual({ ok: false, message: "Scanner is busy" });
    expect(
      await checkScanner(
        makeDevice({ statuses: [empty] }).ports,
        feeder("fronts"),
      ),
    ).toEqual({ ok: false, message: "No document in the feeder" });
  });

  it("does not look at the feeder for the flatbed", async () => {
    const { ports } = makeDevice({ statuses: [empty] });
    expect(await checkScanner(ports, feeder("flatbed"))).toEqual({ ok: true });
  });
});

describe("runScan", () => {
  it("scans a feeder batch: application/xml, pages in order, final status, DELETE", async () => {
    const dev = makeDevice({
      statuses: [loaded, done(3)],
      nexts: [
        { status: 200, ms: 400 },
        { status: 200, ms: 3000 },
        { status: 200, ms: 100 },
        { status: 404 },
      ],
    });
    const result = await runScan(dev.ports, feeder());
    expect(result.complete).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.pages).toHaveLength(3);
    expect(dev.posted).toHaveLength(1);
    expect(dev.posted[0].contentType).toBe("application/xml");
    expect(dev.posted[0].body).toContain(
      "<pwg:InputSource>Feeder</pwg:InputSource>",
    );
    expect(dev.posted[0].body).toContain(
      "<scan:XResolution>300</scan:XResolution>",
    );
    // min(1 s, half the previous page request) between two page requests.
    expect(dev.sleeps).toEqual([200, 1000, 50]);
    expect(dev.calls.at(-1)).toBe(`DELETE ${HOST}/eSCL/ScanJobs/1`);
    expect(dev.logs).toContain(
      "page 2: " + result.pages[1].length + " bytes, 3000 ms",
    );
    expect(dev.logs).toContain(
      "final: state=Idle adf=ScannerAdfEmpty job=Completed imagesCompleted=3 received=3",
    );
  });

  it("reports the number of pages after every downloaded page", async () => {
    const dev = makeDevice({
      statuses: [loaded, done(3)],
      nexts: [{ status: 200 }, { status: 200 }, { status: 200 }],
    });
    const seen: number[] = [];
    dev.ports.onPage = (n) => seen.push(n);
    await runScan(dev.ports, feeder());
    expect(seen).toEqual([1, 2, 3]);
  });

  it("retries a 503 on the job creation, 1 s apart", async () => {
    const dev = makeDevice({
      statuses: [loaded, done(1)],
      posts: [{ status: 503 }, { status: 503 }, { status: 201 }],
      nexts: [{ status: 200 }],
    });
    const result = await runScan(dev.ports, feeder());
    expect(result.pages).toHaveLength(1);
    expect(dev.calls.filter((c) => c.startsWith("POST"))).toHaveLength(3);
    expect(dev.sleeps.slice(0, 2)).toEqual([1000, 1000]);
  });

  it("gives up on the job creation after 10 retries", async () => {
    const dev = makeDevice({
      statuses: [loaded],
      posts: Array.from({ length: 20 }, () => ({ status: 503 })),
    });
    await expect(runScan(dev.ports, feeder())).rejects.toThrow(
      "Scanner refused the scan (HTTP 503)",
    );
    expect(dev.calls.filter((c) => c.startsWith("POST"))).toHaveLength(11);
  });

  it("names any other status of the job creation", async () => {
    const dev = makeDevice({ statuses: [loaded], posts: [{ status: 400 }] });
    await expect(runScan(dev.ports, feeder())).rejects.toThrow("HTTP 400");
    expect(dev.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("retries a 503 on NextDocument", async () => {
    const dev = makeDevice({
      statuses: [loaded, done(2)],
      nexts: [
        { status: 200, ms: 20 },
        { status: 503 },
        { status: 503 },
        { status: 200, ms: 20 },
        { status: 404 },
      ],
    });
    const result = await runScan(dev.ports, feeder());
    expect(result.pages).toHaveLength(2);
    expect(result.complete).toBe(true);
    expect(dev.sleeps).toEqual([10, 1000, 1000, 10]);
  });

  it("asks again after an early 404 while the scanner is still processing", async () => {
    // The feeder reads "empty" from the 2nd second of a running job: no evidence.
    const dev = makeDevice({
      statuses: [loaded, running, done(2)],
      nexts: [
        { status: 200, ms: 200 },
        { status: 404 },
        { status: 200, ms: 200 },
        { status: 404 },
      ],
    });
    const result = await runScan(dev.ports, feeder());
    expect(result.pages).toHaveLength(2);
    expect(result.complete).toBe(true);
    // wait after page 1, the 1 s busy wait, wait after page 2
    expect(dev.sleeps).toEqual([100, 1000, 100]);
  });

  it("asks again while our job is listed as still processing or pending", async () => {
    for (const state of ["Processing", "Pending"]) {
      const dev = makeDevice({
        statuses: [
          loaded,
          { state: "Idle", adf: "ScannerAdfEmpty", job: { state } },
          done(2),
        ],
        nexts: [
          { status: 200 },
          { status: 404 },
          { status: 200 },
          { status: 404 },
        ],
      });
      const result = await runScan(dev.ports, feeder());
      expect(result.pages).toHaveLength(2);
      expect(result.complete).toBe(true);
    }
  });

  it("stops asking after BUSY_RETRIES busy 404s and reports the batch incomplete", async () => {
    const dev = makeDevice({
      statuses: [loaded, running],
      nexts: [{ status: 200 }],
    });
    const result = await runScan(dev.ports, feeder());
    expect(result.pages).toHaveLength(1);
    expect(result).toMatchObject({
      complete: false,
      reason: "scanner still busy after the last page",
    });
    expect(dev.calls.filter((c) => c === NEXT)).toHaveLength(
      1 + 1 + BUSY_RETRIES,
    );
  });

  it("resets the busy counter after each downloaded page", async () => {
    const nexts: NextSpec[] = [];
    for (let page = 0; page < 3; page++) {
      nexts.push(
        { status: 200 },
        ...Array.from({ length: 4 }, () => ({ status: 404 })),
      );
    }
    nexts.push({ status: 404 });
    const dev = makeDevice({
      statuses: [
        loaded,
        running,
        running,
        running,
        running,
        running,
        running,
        running,
        running,
        running,
        running,
        running,
        running,
        done(3),
      ],
      nexts,
    });
    const result = await runScan(dev.ports, feeder());
    expect(result.pages).toHaveLength(3);
    expect(result.complete).toBe(true);
  });

  it("is complete when the scanner counted exactly the pages received", async () => {
    const dev = makeDevice({
      statuses: [loaded, done(2)],
      nexts: [{ status: 200 }, { status: 200 }],
    });
    expect(await runScan(dev.ports, feeder())).toMatchObject({
      complete: true,
      pages: expect.any(Array),
    });
  });

  it("trusts a completed job that reports no image count", async () => {
    const dev = makeDevice({
      statuses: [
        loaded,
        { state: "Idle", adf: "ScannerAdfEmpty", job: { state: "Completed" } },
      ],
      nexts: [{ status: 200 }],
    });
    expect((await runScan(dev.ports, feeder())).complete).toBe(true);
  });

  it("reports a count mismatch between the job record and the pages received", async () => {
    const dev = makeDevice({
      statuses: [loaded, done(5)],
      nexts: [{ status: 200 }, { status: 200 }, { status: 200 }],
    });
    const result = await runScan(dev.ports, feeder());
    expect(result.pages).toHaveLength(3);
    expect(result).toMatchObject({
      complete: false,
      reason: "scanner counted 5 pages, received 3",
    });
  });

  it("reports a job cancelled at the device, and other cancelled or aborted jobs, in words", async () => {
    const cases: [JobSpec, string][] = [
      [
        { state: "Canceled", images: 1, reason: "JobCanceledAtDevice" },
        "the scanner cancelled the scan (the feeder did not pick up the paper)",
      ],
      [
        { state: "Aborted", images: 1, reason: "JobAbortedBySystem" },
        "job aborted by system",
      ],
      [{ state: "Canceled", images: 1 }, "job canceled"],
    ];
    for (const [job, reason] of cases) {
      const dev = makeDevice({
        statuses: [loaded, { state: "Idle", adf: "ScannerAdfEmpty", job }],
        nexts: [{ status: 200 }],
      });
      const result = await runScan(dev.ports, feeder());
      expect(result.pages).toHaveLength(1);
      expect(result).toMatchObject({ complete: false, reason });
    }
  });

  it("does not take an empty feeder as proof when the job is Canceled", async () => {
    const dev = makeDevice({
      statuses: [
        loaded,
        { state: "Idle", adf: "ScannerAdfEmpty", job: { state: "Canceled" } },
      ],
      nexts: [{ status: 200 }],
    });
    expect((await runScan(dev.ports, feeder())).complete).toBe(false);
  });

  it("matches our job by its id, whatever the URL form and position", async () => {
    const dev = makeDevice({
      statuses: [loaded, done(1)],
      posts: [{ status: 201, location: `${HOST}/eSCL/ScanJobs/1/` }],
      nexts: [{ status: 200 }],
    });
    expect((await runScan(dev.ports, feeder())).complete).toBe(true);
  });

  it("falls back to the feeder state when the job is not listed and the scanner is idle", async () => {
    const empty = makeDevice({
      statuses: [loaded, { state: "Idle", adf: "ScannerAdfEmpty" }],
      nexts: [{ status: 200 }],
    });
    expect((await runScan(empty.ports, feeder())).complete).toBe(true);

    const rest: [StatusSpec, string][] = [
      [{ state: "Idle", adf: "ScannerAdfJam" }, "paper jam"],
      [{ state: "Idle", adf: "ScannerAdfMispick" }, "paper not picked up"],
      [loaded, "paper still in the feeder"],
      ["unreachable", "scanner status unreadable"],
    ];
    for (const [status, reason] of rest) {
      const dev = makeDevice({
        statuses: [loaded, status],
        nexts: [{ status: 200 }],
      });
      expect(await runScan(dev.ports, feeder())).toMatchObject({
        complete: false,
        reason,
      });
    }
  });

  it("reads the job record before it deletes the job", async () => {
    const dev = makeDevice({
      statuses: [loaded, done(1)],
      nexts: [{ status: 200 }],
    });
    await runScan(dev.ports, feeder());
    const lastStatus = dev.calls
      .map((c) => c.endsWith("/ScannerStatus"))
      .lastIndexOf(true);
    expect(dev.calls.findIndex((c) => c.startsWith("DELETE"))).toBeGreaterThan(
      lastStatus,
    );
  });

  it("keeps the pages when a later page fails for good", async () => {
    const dev = makeDevice({
      statuses: [loaded, { state: "Idle", adf: "ScannerAdfJam" }],
      nexts: [{ status: 200 }, { status: 200 }, { status: 500 }],
    });
    const result = await runScan(dev.ports, feeder());
    expect(result.pages).toHaveLength(2);
    expect(result).toMatchObject({
      complete: false,
      reason: "page 3 failed (HTTP 500)",
    });
    expect(dev.calls.at(-1)).toMatch(/^DELETE/);
    // a failed page still gets one look at the job record, for the log
    expect(dev.logs).toContain(
      "final: state=Idle adf=ScannerAdfJam job=unlisted imagesCompleted=n/a received=2",
    );
  });

  it("keeps the pages when NextDocument stays 503 or the scanner stops answering", async () => {
    const busy = makeDevice({
      statuses: [loaded],
      nexts: [
        { status: 200 },
        ...Array.from({ length: 40 }, () => ({ status: 503 })),
      ],
    });
    const result = await runScan(busy.ports, feeder());
    expect(result.reason).toBe("page 2 failed (HTTP 503)");
    expect(busy.calls.filter((c) => c === NEXT)).toHaveLength(1 + 31);

    const gone = makeDevice({
      statuses: [loaded],
      nexts: [{ status: 200 }, { status: 0 }],
    });
    expect((await runScan(gone.ports, feeder())).reason).toBe(
      "page 2 failed (no answer from the scanner)",
    );
  });

  it("keeps the pages when a page download throws after the first", async () => {
    const dev = makeDevice({
      statuses: [loaded],
      nexts: [{ status: 200 }, "throw"],
    });
    const result = await runScan(dev.ports, feeder());
    expect(result.pages).toHaveLength(1);
    expect(result).toMatchObject({ complete: false, reason: "curl exploded" });
  });

  it("stops at the overall deadline as an incomplete batch and still deletes the job", async () => {
    const dev = makeDevice({
      statuses: [loaded],
      nexts: [
        { status: 200, ms: SCAN_DEADLINE_MS / 2 },
        { status: 200, ms: SCAN_DEADLINE_MS / 2 },
        { status: 200 },
      ],
    });
    const result = await runScan(dev.ports, feeder());
    expect(result.pages).toHaveLength(2);
    expect(result).toMatchObject({ complete: false, reason: "timed out" });
    expect(dev.calls.at(-1)).toMatch(/^DELETE/);
    expect(Math.max(...dev.downloadTimeouts)).toBeLessThanOrEqual(120);
  });

  it("explains a 410 on the first page, and keeps the pages of a later one", async () => {
    const first = makeDevice({ statuses: [loaded], nexts: [{ status: 410 }] });
    await expect(runScan(first.ports, feeder())).rejects.toThrow(
      CANCELLED_TRY_AGAIN,
    );
    expect(first.logs).toContain("page 1: HTTP 410"); // the raw status stays in the log
    expect(first.calls.at(-1)).toMatch(/^DELETE/);

    const later = makeDevice({
      statuses: [loaded],
      nexts: [{ status: 200 }, { status: 410 }],
    });
    const result = await runScan(later.ports, feeder());
    expect(result.pages).toHaveLength(1);
    expect(result).toMatchObject({ complete: false, reason: FEEDER_CANCELLED });
    expect(later.logs).toContain("page 2: HTTP 410");
  });

  it("refuses an empty feeder before any POST", async () => {
    const dev = makeDevice({ statuses: [empty] });
    await expect(runScan(dev.ports, feeder())).rejects.toThrow(
      "No document in the feeder",
    );
    expect(dev.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("refuses a busy scanner", async () => {
    const dev = makeDevice({
      statuses: [{ state: "Processing", adf: "ScannerAdfLoaded" }],
    });
    await expect(runScan(dev.ports, feeder())).rejects.toBeInstanceOf(
      ScanError,
    );
    expect(dev.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("throws when the scanner returns no pages, and still deletes the job", async () => {
    const dev = makeDevice({ statuses: [loaded], nexts: [{ status: 404 }] });
    await expect(runScan(dev.ports, feeder())).rejects.toThrow(
      "The scanner returned no pages",
    );
    expect(dev.calls.at(-1)).toMatch(/^DELETE/);
  });

  it("throws the reason when the first page already fails", async () => {
    const dev = makeDevice({ statuses: [loaded], nexts: [{ status: 500 }] });
    await expect(runScan(dev.ports, feeder())).rejects.toThrow(
      "page 1 failed (HTTP 500)",
    );
  });

  it("sends DELETE when the first page download throws", async () => {
    const dev = makeDevice({ statuses: [loaded], nexts: ["throw"] });
    await expect(runScan(dev.ports, feeder())).rejects.toThrow("curl exploded");
    expect(dev.calls.at(-1)).toBe(`DELETE ${HOST}/eSCL/ScanJobs/1`);
  });

  it("stops after one page on the flatbed", async () => {
    const dev = makeDevice({
      statuses: [empty],
      nexts: [{ status: 200 }, { status: 200 }],
    });
    const result = await runScan(dev.ports, feeder("flatbed"));
    expect(result.pages).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(dev.calls.filter((c) => c === NEXT)).toHaveLength(1);
    expect(dev.posted[0].body).toContain(
      "<pwg:InputSource>Platen</pwg:InputSource>",
    );
  });
});

describe("adfProblem", () => {
  it("says what the feeder state means", () => {
    expect(adfProblem("ScannerAdfJam")).toBe("paper jam");
    expect(adfProblem("ScannerAdfMispick")).toBe("paper not picked up");
    expect(adfProblem("ScannerAdfHatchOpen")).toBe("feeder cover open");
    expect(adfProblem("ScannerAdfLoaded")).toBe("paper still in the feeder");
    expect(adfProblem(null)).toBe("scanner status unreadable");
    expect(adfProblem("ScannerAdfOdd")).toBe("feeder state ScannerAdfOdd");
  });
});
