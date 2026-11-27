import { describe, expect, it } from "vitest";
import {
  buildRequest,
  checkFile,
  lpArgs,
  MAX_COPIES,
  parsePages,
  PrintRequest,
} from "./options";

describe("parsePages", () => {
  it.each(["1", "1-3", "1-3,5", "8-", "5,1-2", " 1 - 3 , 5 "])(
    "accepts %j",
    (text) => {
      expect(parsePages(text).ok).toBe(true);
    },
  );

  it.each([
    ["0", "start at 1"],
    ["0-3", "start at 1"],
    ["5-3", "Reversed"],
    ["1,,2", "Invalid"],
    ["-3", "Invalid"],
    ["1-2-3", "Invalid"],
    ["a", "Invalid"],
    ["1.5", "Invalid"],
  ])("refuses %j", (text, reason) => {
    const result = parsePages(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(reason);
  });

  it("removes the spaces it accepts", () => {
    expect(parsePages(" 1 - 3 , 5 ")).toEqual({ ok: true, value: "1-3,5" });
  });
});

describe("buildRequest", () => {
  it("defaults to two-sided long edge, A4, one copy, one page per sheet", () => {
    const result = buildRequest({ file: "/tmp/a.pdf" });
    expect(result).toEqual({
      ok: true,
      value: {
        file: "/tmp/a.pdf",
        printer: undefined,
        sides: "two-sided-long-edge",
        pages: undefined,
        copies: 1,
        nUp: 1,
        quality: undefined,
        manualFeed: false,
        media: "A4",
        hold: false,
      },
    });
  });

  it("treats an empty page list as all pages", () => {
    const result = buildRequest({ file: "/tmp/a.pdf", pages: "  " });
    expect(result.ok && result.value.pages).toBeUndefined();
  });

  it.each([
    [{ copies: 0 }, "Copies"],
    [{ copies: MAX_COPIES + 1 }, "Copies"],
    [{ copies: 1.5 }, "Copies"],
    [{ copies: Number.NaN }, "Copies"],
    [{ nUp: 3 }, "--n-up"],
    [{ quality: "best" }, "--quality"],
    [{ media: "A3" }, "--media"],
    [{ pages: "5-3" }, "Reversed"],
  ])("refuses %j with a one-line message", (extra, message) => {
    const result = buildRequest({ file: "/tmp/a.pdf", ...extra });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(message);
  });

  it("accepts the largest copy count", () => {
    expect(buildRequest({ file: "/x.pdf", copies: MAX_COPIES }).ok).toBe(true);
  });
});

describe("checkFile", () => {
  const isFile = { isFile: true };
  const stat = (path: string) =>
    path === "/tmp/dir"
      ? { isFile: false }
      : path.startsWith("/tmp/")
        ? isFile
        : null;

  it("accepts a regular file with a printable extension, any case", () => {
    expect(checkFile("/tmp/scan.PDF", stat)).toEqual({
      ok: true,
      value: "/tmp/scan.PDF",
    });
  });

  it("refuses a missing file", () => {
    expect(checkFile("/nope/a.pdf", stat)).toEqual({
      ok: false,
      message: "No such file: /nope/a.pdf",
    });
  });

  it("refuses a directory", () => {
    const result = checkFile("/tmp/dir", stat);
    expect(result.ok).toBe(false);
  });

  it("refuses an extension that is not printable", () => {
    const result = checkFile("/tmp/app.exe", stat);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"exe"');
  });
});

describe("lpArgs", () => {
  const base: PrintRequest = {
    file: "/tmp/x.pdf",
    printer: "Example_Printer",
    sides: "two-sided-long-edge",
    copies: 1,
    nUp: 1,
    manualFeed: false,
    media: "A4",
    hold: false,
  };

  it("passes sides, media and fit explicitly, with the file last", () => {
    expect(lpArgs(base)).toEqual([
      "-d",
      "Example_Printer",
      "-n",
      "1",
      "-o",
      "sides=two-sided-long-edge",
      "-o",
      "media=A4",
      "-o",
      "fit-to-page",
      "-t",
      "x.pdf",
      "--",
      "/tmp/x.pdf",
    ]);
  });

  it("maps pages, copies, one-sided, quality, n-up, manual feed and hold", () => {
    expect(
      lpArgs({
        ...base,
        sides: "one-sided",
        copies: 2,
        nUp: 4,
        quality: "high",
        manualFeed: true,
        pages: "1-3,5",
        hold: true,
      }),
    ).toEqual([
      "-d",
      "Example_Printer",
      "-n",
      "2",
      "-o",
      "sides=one-sided",
      "-o",
      "media=A4",
      "-o",
      "fit-to-page",
      "-o",
      "number-up=4",
      "-o",
      "print-quality=5",
      "-o",
      "InputSlot=manual",
      "-P",
      "1-3,5",
      "-H",
      "hold",
      "-t",
      "x.pdf",
      "--",
      "/tmp/x.pdf",
    ]);
  });

  it("omits the printer flag when no queue was resolved", () => {
    expect(lpArgs({ ...base, printer: undefined })[0]).toBe("-n");
  });
});
