// The curl-backed `ScanHttp`. Like the Netgear transport it shells out to the
// system curl rather than relying on Tinycast's fetch bridge (plain-http LAN
// device, unconfirmed behaviour there); this also runs in the detached bun
// process, where curl is just as available. Callback-style `execFile`.

import { execFile } from "child_process";
import { ScanHttp } from "./runner";

const CURL_BIN = "/usr/bin/curl";

// curl exit codes for "could not talk to the host": unsupported/bad URL is a
// bug and rejects, these are the scanner being away and become status 0.
const CONNECTION_FAILURES = new Set([5, 6, 7, 18, 28, 35, 52, 55, 56]);

interface CurlResult {
  code: number;
  stdout: string;
}

function runCurl(args: string[], stdin?: string): Promise<CurlResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      CURL_BIN,
      args,
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) return resolve({ code: 0, stdout });
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code === "number" && CONNECTION_FAILURES.has(code)) {
          return resolve({ code, stdout });
        }
        reject(error);
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin ?? "");
  });
}

const parseCode = (text: string): number => parseInt(text.trim(), 10) || 0;

export const curlScanHttp: ScanHttp = {
  async get(url, timeoutS) {
    const res = await runCurl([
      "-s",
      "-m",
      String(timeoutS),
      "-w",
      "\n%{http_code}",
      url,
    ]);
    if (res.code !== 0) return { status: 0, body: "" };
    const idx = res.stdout.lastIndexOf("\n");
    if (idx === -1) return { status: parseCode(res.stdout), body: "" };
    return {
      body: res.stdout.slice(0, idx),
      status: parseCode(res.stdout.slice(idx + 1)),
    };
  },

  async post(url, contentType, body, timeoutS) {
    const res = await runCurl(
      [
        "-s",
        "-m",
        String(timeoutS),
        "-D",
        "-",
        "-o",
        "/dev/null",
        "-X",
        "POST",
        "-H",
        `Content-Type: ${contentType}`,
        "-H",
        "Expect:",
        "--data-binary",
        "@-",
        url,
      ],
      body,
    );
    if (res.code !== 0) return { status: 0, location: null };
    return parsePostHeaders(res.stdout);
  },

  async download(url, destPath, timeoutS) {
    const startedAt = Date.now();
    const res = await runCurl([
      "-s",
      "-m",
      String(timeoutS),
      "-o",
      destPath,
      "-w",
      "%{http_code}",
      url,
    ]);
    return {
      status: res.code !== 0 ? 0 : parseCode(res.stdout),
      ms: Date.now() - startedAt,
    };
  },

  async del(url) {
    await runCurl(["-s", "-m", "10", "-o", "/dev/null", "-X", "DELETE", url])
      .then(() => undefined)
      .catch(() => undefined);
  },
};

// `curl -D -` prints one header block per response (a `100 Continue` first,
// redirects): the last status line and `Location` are the answer.
export function parsePostHeaders(headers: string): {
  status: number;
  location: string | null;
} {
  let status = 0;
  let location: string | null = null;
  for (const line of headers.split(/\r?\n/)) {
    const statusLine = /^HTTP\/\S+\s+(\d{3})/i.exec(line);
    if (statusLine) {
      status = Number(statusLine[1]);
      location = null;
      continue;
    }
    const loc = /^location:\s*(.+?)\s*$/i.exec(line);
    if (loc) location = loc[1];
  }
  return { status, location };
}
