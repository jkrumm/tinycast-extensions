import { describe, expect, it } from "vitest";
import { historyImage, metricsImage, panelImage } from "./heroes";
import { SpeedTestRecord } from "./types";

const decode = (uri: string) =>
  Buffer.from(uri.split(";base64,")[1].split("?")[0], "base64").toString();

const record = (over: Partial<SpeedTestRecord> = {}): SpeedTestRecord => ({
  timestamp: 1_700_000_000_000,
  full: true,
  dlMbps: 100,
  ulMbps: 20,
  latencyMs: 42,
  responsiveness: 812.4,
  dataUsedMB: 40,
  interfaceName: "en0",
  ...over,
});

describe("speed-test panel", () => {
  it("download and upload with the average of the stored tests", () => {
    const history = [record(), record({ dlMbps: 60 }), record({ dlMbps: 80 })];
    const svg = decode(panelImage(history[0], history));
    expect(svg).toContain(">DOWNLOAD<");
    expect(svg).toContain(">UPLOAD<");
    expect(svg).toContain("avg 80 of last 3");
    expect(svg).toContain(">Mbps<");
  });

  it("a quick test has no upload column, and no average under three tests", () => {
    const quick = record({ ulMbps: null, full: false });
    const svg = decode(panelImage(quick, [quick]));
    expect(svg).not.toContain("UPLOAD");
    expect(svg).not.toContain("avg ");
  });
});

describe("speed-test metrics row", () => {
  it("latency, responsiveness and interface", () => {
    const svg = decode(metricsImage(record()));
    expect(svg).toContain(">LATENCY<");
    expect(svg).toContain(">42<");
    expect(svg).toContain(">812<");
    expect(svg).toContain(">RPM<");
    expect(svg).toContain(">en0<");
  });

  it("drops responsiveness on a quick test", () => {
    const svg = decode(metricsImage(record({ responsiveness: null })));
    expect(svg).not.toContain("RESPONSIVENESS");
    expect(svg).toContain(">en0<");
  });
});

describe("speed-test history chart", () => {
  it("needs two tests, and does not repeat the panel's numbers", () => {
    expect(historyImage([record()])).toBeNull();
    const svg = decode(
      historyImage([record({ dlMbps: 137 }), record({ dlMbps: 55 })])!,
    );
    expect(svg).toContain("Download (Mbps)");
    // no last-value in the legend or chip: ">137<" would be the panel again
    expect(svg).not.toContain(">137<");
  });
});
