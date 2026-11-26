import { describe, expect, it } from "vitest";
import { parsePostHeaders } from "./transport";

describe("parsePostHeaders", () => {
  it("reads the status and Location of the created job", () => {
    expect(
      parsePostHeaders(
        "HTTP/1.1 201 Created\r\nLocation: http://10.0.0.2/eSCL/ScanJobs/4\r\nContent-Length: 0\r\n\r\n",
      ),
    ).toEqual({ status: 201, location: "http://10.0.0.2/eSCL/ScanJobs/4" });
  });

  it("takes the last block after a 100 Continue", () => {
    expect(
      parsePostHeaders(
        "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 503 Service Unavailable\r\n\r\n",
      ),
    ).toEqual({ status: 503, location: null });
  });

  it("is status 0 for no response", () => {
    expect(parsePostHeaders("")).toEqual({ status: 0, location: null });
  });
});
