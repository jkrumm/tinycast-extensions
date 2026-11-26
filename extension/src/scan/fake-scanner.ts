// An in-process fake of an eSCL scanner for the real curl transport over
// 127.0.0.1: ScannerStatus (scanner + feeder state from the mutable `state`),
// ScanJobs (400 unless the body is sent as `application/xml`, like the real
// device that otherwise ignores resolution and region), NextDocument serving
// N synthetic JPEGs and then 404, and DELETE. `minPageGapMs` reproduces the
// Brother quirk (404 to a request that comes too soon after a page while pages
// remain).
//
// It models what the real device does with its status: while a job runs the
// scanner reads `Processing` and the feeder reads `ScannerAdfEmpty` (it is no
// evidence of anything), the running job is NOT listed in `<scan:Jobs>`, and a
// finished one is listed (`Completed` with `ImagesCompleted`, or `Canceled`
// with `JobCanceledAtDevice`) and stays listed after DELETE.
//
// It exists so the integration suites never need a real scanner — AGENTS.md
// § Safety. Dev/test tooling only: nothing in a command bundle imports it.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "net";
import { syntheticJpeg } from "./fixtures";

export interface FakeScannerState {
  adfState: string; // ScannerAdfLoaded before a job; Empty from the job's start on
  pages: number; // pages the next job serves
  pageDelayMs: number; // time a page takes to come out
  minPageGapMs: number; // 404 to a next-page request sooner than this
  failPosts: number; // answer the next N job creations with 503
  failNextDocuments: number; // answer the next N page requests with 503
  failPageAt: number | null; // 1-based page that answers 500
  cancelAfter: number | null; // the job ends Canceled at the device after N pages
  pickupFails: boolean; // the feeder never picks up the paper: first page request answers 410
  scanning: boolean;
  requests: FakeScannerRequest[];
  settings: string | null; // body of the last accepted job
  deleted: number;
}

export interface FakeScannerRequest {
  method: string;
  path: string;
  contentType: string | null;
  at: number;
}

export interface FakeScanner {
  url: string;
  state: FakeScannerState;
  close(): Promise<void>;
}

interface JobRecord {
  id: string;
  state: "Completed" | "Canceled";
  reason: string;
  images: number;
}

const jobUuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const jobInfoXml = (job: JobRecord): string =>
  `<scan:JobInfo><pwg:JobUri>/eSCL/ScanJobs/${job.id}</pwg:JobUri><pwg:JobUuid>urn:uuid:${job.id}</pwg:JobUuid><scan:Age>1000</scan:Age><pwg:ImagesCompleted>${job.images}</pwg:ImagesCompleted><pwg:ImagesToTransfer>0</pwg:ImagesToTransfer><pwg:JobState>${job.state}</pwg:JobState><pwg:JobStateReasons><pwg:JobStateReason>${job.reason}</pwg:JobStateReason></pwg:JobStateReasons></scan:JobInfo>`;

function statusXml(state: FakeScannerState, records: JobRecord[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerStatus xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm" xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03">
<pwg:Version>2.63</pwg:Version>
<pwg:State>${state.scanning ? "Processing" : "Idle"}</pwg:State>
<scan:AdfState>${state.adfState}</scan:AdfState>
<scan:Jobs>${records.map(jobInfoXml).join("")}</scan:Jobs>
</scan:ScannerStatus>`;
}

export async function startFakeScanner(
  initial: Partial<FakeScannerState> = {},
): Promise<FakeScanner> {
  const state: FakeScannerState = {
    adfState: "ScannerAdfLoaded",
    pages: 3,
    pageDelayMs: 0,
    minPageGapMs: 0,
    failPosts: 0,
    failNextDocuments: 0,
    failPageAt: null,
    cancelAfter: null,
    pickupFails: false,
    scanning: false,
    requests: [],
    settings: null,
    deleted: 0,
    ...initial,
  };
  let served = 0;
  let lastPageAt = 0;
  let port = 0;
  let jobsCreated = 0;
  let currentJob = "";
  // Past jobs, one of them from before this fake's first scan.
  const records: JobRecord[] = [
    {
      id: jobUuid(0),
      state: "Completed",
      reason: "JobCompletedSuccessfully",
      images: 5,
    },
  ];
  const finishJob = (outcome: Pick<JobRecord, "state" | "reason">): void => {
    state.scanning = false;
    records.push({ id: currentJob, images: served, ...outcome });
  };

  const reply = (
    res: ServerResponse,
    status: number,
    headers: Record<string, string | number> = {},
    body: Uint8Array | string = "",
  ): void => {
    res.writeHead(status, headers);
    res.end(body);
  };

  const handle = (
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
  ): void => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "").split("?")[0];
    const contentType = req.headers["content-type"] ?? null;
    state.requests.push({ method, path, contentType, at: Date.now() });

    if (method === "GET" && path === "/eSCL/ScannerStatus") {
      return reply(
        res,
        200,
        { "Content-Type": "text/xml" },
        statusXml(state, records),
      );
    }

    if (method === "POST" && path === "/eSCL/ScanJobs") {
      if (state.failPosts > 0) {
        state.failPosts--;
        return reply(res, 503);
      }
      if (!contentType?.toLowerCase().startsWith("application/xml")) {
        return reply(res, 400);
      }
      state.settings = body;
      state.scanning = true;
      state.adfState = "ScannerAdfEmpty"; // reads empty while the job runs
      served = 0;
      lastPageAt = 0;
      currentJob = jobUuid(++jobsCreated);
      return reply(res, 201, {
        Location: `http://127.0.0.1:${port}/eSCL/ScanJobs/${currentJob}`,
      });
    }

    if (
      method === "GET" &&
      path === `/eSCL/ScanJobs/${currentJob}/NextDocument`
    ) {
      if (!state.scanning) return reply(res, 404);
      if (state.failNextDocuments > 0) {
        state.failNextDocuments--;
        return reply(res, 503);
      }
      if (state.pickupFails && served === 0) {
        finishJob({ state: "Canceled", reason: "JobCanceledAtDevice" });
        return reply(res, 410);
      }
      if (state.cancelAfter !== null && served >= state.cancelAfter) {
        finishJob({ state: "Canceled", reason: "JobCanceledAtDevice" });
        return reply(res, 404);
      }
      if (served >= state.pages) return reply(res, 404);
      if (served > 0 && Date.now() - lastPageAt < state.minPageGapMs) {
        return reply(res, 404);
      }
      if (state.failPageAt === served + 1) return reply(res, 500);
      served++;
      const jpeg = syntheticJpeg({ width: 2480, height: 3507 });
      // The job is listed as Completed once its last page was fetched.
      if (served >= state.pages) {
        finishJob({ state: "Completed", reason: "JobCompletedSuccessfully" });
      }
      setTimeout(() => {
        lastPageAt = Date.now();
        reply(
          res,
          200,
          { "Content-Type": "image/jpeg", "Content-Length": jpeg.length },
          jpeg,
        );
      }, state.pageDelayMs);
      return;
    }

    if (method === "DELETE" && path === `/eSCL/ScanJobs/${currentJob}`) {
      state.deleted++;
      state.scanning = false; // a finished job's record stays listed
      return reply(res, 200);
    }

    return reply(res, 404);
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => handle(req, res, body));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
