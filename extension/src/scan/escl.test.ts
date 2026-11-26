import { describe, expect, it } from "vitest";
import {
  findJob,
  frontsStemOf,
  jobUrl,
  numberedFileName,
  parseBrowse,
  parseLookup,
  parseScannerStatus,
  scanFileName,
  scanSettingsXml,
  sourceFor,
} from "./escl";

describe("scanSettingsXml", () => {
  it("is the A4 / 300 dpi / JPEG settings document with the values substituted", () => {
    const xml = scanSettingsXml({
      source: "Feeder",
      dpi: 300,
      color: "RGB24",
    });
    expect(xml.split("\n")).toEqual([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">',
      "<pwg:Version>2.63</pwg:Version>",
      "<scan:Intent>Document</scan:Intent>",
      "<pwg:ScanRegions><pwg:ScanRegion><pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits><pwg:XOffset>0</pwg:XOffset><pwg:YOffset>0</pwg:YOffset><pwg:Width>2480</pwg:Width><pwg:Height>3507</pwg:Height></pwg:ScanRegion></pwg:ScanRegions>",
      "<pwg:InputSource>Feeder</pwg:InputSource>",
      "<scan:ColorMode>RGB24</scan:ColorMode>",
      "<scan:XResolution>300</scan:XResolution>",
      "<scan:YResolution>300</scan:YResolution>",
      "<pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>",
      "<scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>",
      "</scan:ScanSettings>",
    ]);
  });

  it("substitutes source and resolution", () => {
    const xml = scanSettingsXml({ source: "Platen", dpi: 600, color: "RGB24" });
    expect(xml).toContain("<pwg:InputSource>Platen</pwg:InputSource>");
    expect(xml).toContain("<scan:XResolution>600</scan:XResolution>");
  });

  it("maps modes to sources", () => {
    expect(sourceFor("feeder")).toBe("Feeder");
    expect(sourceFor("fronts")).toBe("Feeder");
    expect(sourceFor("backs")).toBe("Feeder");
    expect(sourceFor("flatbed")).toBe("Platen");
  });
});

describe("parseScannerStatus", () => {
  it("reads the scanner state and the ADF state", () => {
    const xml = `<scan:ScannerStatus xmlns:pwg="x" xmlns:scan="y">
<pwg:Version>2.63</pwg:Version><pwg:State>Idle</pwg:State>
<scan:AdfState>ScannerAdfLoaded</scan:AdfState></scan:ScannerStatus>`;
    expect(parseScannerStatus(xml)).toEqual({
      state: "Idle",
      adfState: "ScannerAdfLoaded",
      jobs: [],
    });
  });

  it("ignores JobState elements after the scanner state", () => {
    const xml = `<pwg:State>Processing</pwg:State>
<scan:Jobs><scan:JobInfo><pwg:JobState>Completed</pwg:JobState></scan:JobInfo>
<scan:JobInfo><pwg:JobState>Canceled</pwg:JobState></scan:JobInfo></scan:Jobs>
<scan:AdfState>ScannerAdfEmpty</scan:AdfState>`;
    expect(parseScannerStatus(xml)).toMatchObject({
      state: "Processing",
      adfState: "ScannerAdfEmpty",
    });
  });

  it("does not take a JobState as the state when the state is missing", () => {
    expect(
      parseScannerStatus("<pwg:JobState>Completed</pwg:JobState>").state,
    ).toBeNull();
  });

  it("never throws", () => {
    const nothing = { state: null, adfState: null, jobs: [] };
    expect(parseScannerStatus("")).toEqual(nothing);
    expect(parseScannerStatus(undefined as unknown as string)).toEqual(nothing);
    expect(parseScannerStatus("<scan:JobInfo><pwg:JobUri>")).toEqual(nothing);
  });
});

const UUID = "11111111-2222-3333-4444-0123456789ab";
const MULTI_JOB_STATUS = `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerStatus xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm" xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03">
<pwg:Version>2.63</pwg:Version><pwg:State>Idle</pwg:State>
<scan:AdfState>ScannerAdfEmpty</scan:AdfState>
<scan:Jobs>
<scan:JobInfo><pwg:JobUri>/eSCL/ScanJobs/aaaaaaaa-0000-4000-8000-000000000001</pwg:JobUri><pwg:JobUuid>urn:uuid:aaaaaaaa-0000-4000-8000-000000000001</pwg:JobUuid><scan:Age>99</scan:Age><pwg:ImagesCompleted>7</pwg:ImagesCompleted><pwg:ImagesToTransfer>0</pwg:ImagesToTransfer><pwg:JobState>Canceled</pwg:JobState><pwg:JobStateReasons><pwg:JobStateReason>JobCanceledAtDevice</pwg:JobStateReason></pwg:JobStateReasons></scan:JobInfo>
<scan:JobInfo><pwg:JobUri>/eSCL/ScanJobs/${UUID}</pwg:JobUri><pwg:JobUuid>urn:uuid:${UUID}</pwg:JobUuid><scan:Age>28463849</scan:Age><pwg:ImagesCompleted>29</pwg:ImagesCompleted><pwg:ImagesToTransfer>0</pwg:ImagesToTransfer><pwg:JobState>Completed</pwg:JobState><pwg:JobStateReasons><pwg:JobStateReason>JobCompletedSuccessfully</pwg:JobStateReason></pwg:JobStateReasons></scan:JobInfo>
<scan:JobInfo><pwg:JobUri>/eSCL/ScanJobs/bbbbbbbb-0000-4000-8000-000000000002</pwg:JobUri><pwg:JobState>Completed</pwg:JobState></scan:JobInfo>
</scan:Jobs>
</scan:ScannerStatus>`;

describe("parseScannerStatus jobs", () => {
  const status = parseScannerStatus(MULTI_JOB_STATUS);

  it("lists every job with its state, image count and reason", () => {
    expect(status.state).toBe("Idle");
    expect(status.adfState).toBe("ScannerAdfEmpty");
    expect(status.jobs).toEqual([
      {
        uri: "/eSCL/ScanJobs/aaaaaaaa-0000-4000-8000-000000000001",
        state: "Canceled",
        imagesCompleted: 7,
        reason: "JobCanceledAtDevice",
      },
      {
        uri: `/eSCL/ScanJobs/${UUID}`,
        state: "Completed",
        imagesCompleted: 29,
        reason: "JobCompletedSuccessfully",
      },
      {
        uri: "/eSCL/ScanJobs/bbbbbbbb-0000-4000-8000-000000000002",
        state: "Completed",
        imagesCompleted: null,
        reason: null,
      },
    ]);
  });

  it("finds our job by id, whatever the position or the URL form", () => {
    for (const url of [
      `http://scanner.test/eSCL/ScanJobs/${UUID}`,
      `http://scanner.test/eSCL/ScanJobs/${UUID}/`,
      `/eSCL/ScanJobs/${UUID}`,
      `eSCL/ScanJobs/${UUID}`,
    ]) {
      expect(findJob(status, url)).toMatchObject({
        state: "Completed",
        imagesCompleted: 29,
      });
    }
  });

  it("finds nothing for a job that is not listed (it is still running)", () => {
    expect(
      findJob(status, "http://scanner.test/eSCL/ScanJobs/running-job"),
    ).toBeNull();
    expect(findJob(status, "")).toBeNull();
    expect(findJob(parseScannerStatus(""), "/eSCL/ScanJobs/x")).toBeNull();
  });
});

describe("jobUrl", () => {
  it("keeps an absolute location and drops the trailing slash", () => {
    expect(
      jobUrl("http://scanner.local", "http://10.0.0.2/eSCL/ScanJobs/7/"),
    ).toBe("http://10.0.0.2/eSCL/ScanJobs/7");
  });

  it("resolves a path against the base", () => {
    expect(jobUrl("http://scanner.local/", "/eSCL/ScanJobs/7")).toBe(
      "http://scanner.local/eSCL/ScanJobs/7",
    );
    expect(jobUrl("http://scanner.local", "eSCL/ScanJobs/7/")).toBe(
      "http://scanner.local/eSCL/ScanJobs/7",
    );
  });
});

const BROWSE = `Browsing for _uscan._tcp.local.
DATE: ---Thu 26 Nov 2026---
18:28:01.318  ...STARTING...
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
18:28:01.319  Add        2  14 local.               _uscan._tcp.         Example MFC-1234 series
`;

const LOOKUP = `Lookup Example MFC-1234 series._uscan._tcp.local.
18:28:13.698  Example\\032MFC-1234\\032series._uscan._tcp.local. can be reached at EXAMPLE1234.local.:80 (interface 14)
 txtvers=1 vers=2.63 rs=eSCL pdl=application/pdf,image/jpeg is=adf,platen duplex=F
`;

describe("dns-sd parsers", () => {
  it("takes the instance name of the first Add line, spaces included", () => {
    expect(parseBrowse(BROWSE)).toBe("Example MFC-1234 series");
  });

  it("finds nothing before an Add line", () => {
    expect(parseBrowse(BROWSE.split("\n").slice(0, 4).join("\n"))).toBeNull();
    expect(parseBrowse("")).toBeNull();
  });

  it("ignores Remove lines", () => {
    expect(
      parseBrowse(
        "18:28:01.319  Rmv        2  14 local.               _uscan._tcp.         Gone",
      ),
    ).toBeNull();
  });

  it("builds the URL from the reached-at line, without the trailing dot or port 80", () => {
    expect(parseLookup(LOOKUP)).toBe("http://EXAMPLE1234.local");
  });

  it("appends a port other than 80", () => {
    expect(
      parseLookup("x can be reached at EXAMPLE1234.local.:8080 (interface 14)"),
    ).toBe("http://EXAMPLE1234.local:8080");
  });

  it("returns null while the lookup has not answered", () => {
    expect(
      parseLookup("Lookup Example MFC-1234 series._uscan._tcp.local.\n"),
    ).toBeNull();
  });
});

describe("file names", () => {
  const at = new Date(2026, 10, 26, 18, 34, 55);

  it("names feeder and flatbed scans by local time", () => {
    expect(scanFileName("feeder", at)).toBe("scan-2026-11-26-183455.pdf");
    expect(scanFileName("flatbed", at)).toBe("scan-2026-11-26-183455.pdf");
  });

  it("names a continued feeder scan like a plain one", () => {
    expect(scanFileName("more", at)).toBe("scan-2026-11-26-183455.pdf");
    expect(sourceFor("more")).toBe("Feeder");
  });

  it("marks fronts with -vorne", () => {
    expect(scanFileName("fronts", at)).toBe("scan-2026-11-26-183455-vorne.pdf");
  });

  it("names backs after the stem of the last fronts scan", () => {
    const stem = frontsStemOf("scan-2026-11-26-183455-vorne.pdf");
    expect(stem).toBe("scan-2026-11-26-183455");
    expect(scanFileName("backs", new Date(2026, 10, 26, 18, 40, 0), stem)).toBe(
      "scan-2026-11-26-183455-hinten.pdf",
    );
  });

  it("refuses a backs name without a fronts stem", () => {
    expect(() => scanFileName("backs", at)).toThrow();
  });

  it("numbers duplicates before .pdf", () => {
    expect(numberedFileName("a-vorne.pdf", 1)).toBe("a-vorne.pdf");
    expect(numberedFileName("a-vorne.pdf", 3)).toBe("a-vorne-3.pdf");
  });
});
