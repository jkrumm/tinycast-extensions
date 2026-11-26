// Integration suite against the in-process fake scanner (fake-scanner.ts)
// using the REAL curl transport over 127.0.0.1 — the closest thing to the
// device that is safe to run in `make check`. Never touches a real scanner:
// every test asserts its fake's URL is loopback.

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findJob, parseScannerStatus } from "./escl";
import { FakeScanner, startFakeScanner } from "./fake-scanner";
import { jpegsToPdf } from "./pdf";
import {
  CANCELLED_TRY_AGAIN,
  FEEDER_CANCELLED,
  runScan,
  ScanPorts,
} from "./runner";
import { curlScanHttp } from "./transport";

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
      reason: FEEDER_CANCELLED,
    });
    expect(fake.state.deleted).toBe(1);
  });

  it("tells the user to push the stack in when the feeder does not pick up the paper", async () => {
    fake.state.pickupFails = true; // the first page request answers 410
    await expect(
      runScan(ports(), { host: fake.url, mode: "feeder" }),
    ).rejects.toThrow(CANCELLED_TRY_AGAIN);
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
