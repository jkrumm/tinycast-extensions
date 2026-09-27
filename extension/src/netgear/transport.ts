import { spawn } from "child_process";
import { NetgearHttp, NetgearHttpResponse } from "./types";

const CURL_BIN = "/usr/bin/curl";
const TIMEOUT_SECONDS = "8";

// Tinycast's fetch/http bridge has unconfirmed redirect and plain-http/LAN
// behaviour (see docs/netgear-m2.md), so the transport shells out to the
// system curl instead — a known quantity for cookie-jar + redirect handling
// against a plain-http LAN device.
export class CurlNetgearHttp implements NetgearHttp {
  constructor(private readonly cookieJarPath: string) {}

  get(url: string): Promise<NetgearHttpResponse> {
    return runCurl([
      "-s",
      "-m",
      TIMEOUT_SECONDS,
      "-L",
      "-c",
      this.cookieJarPath,
      "-b",
      this.cookieJarPath,
      "-w",
      "\n%{http_code}",
      url,
    ]);
  }

  postForm(
    url: string,
    fields: Record<string, string>,
    opts?: { stdinField?: { name: string; value: string } },
  ): Promise<NetgearHttpResponse> {
    const args = [
      "-s",
      "-m",
      TIMEOUT_SECONDS,
      "-L",
      "-c",
      this.cookieJarPath,
      "-b",
      this.cookieJarPath,
      "-w",
      "\n%{http_code}",
    ];
    for (const [key, value] of Object.entries(fields)) {
      args.push("--data-urlencode", `${key}=${value}`);
    }
    // Secrets (the admin password) never go on argv, where `ps` could see
    // them — curl reads that one field's value from stdin instead.
    if (opts?.stdinField) {
      args.push("--data-urlencode", `${opts.stdinField.name}@-`);
    }
    args.push(url);
    return runCurl(args, opts?.stdinField?.value);
  }
}

function runCurl(args: string[], stdin?: string): Promise<NetgearHttpResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(CURL_BIN, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`curl exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(splitStatus(stdout));
    });
    child.stdin.end(stdin ?? "");
  });
}

function splitStatus(stdout: string): NetgearHttpResponse {
  const idx = stdout.lastIndexOf("\n");
  if (idx === -1) return { status: parseInt(stdout, 10) || 0, body: "" };
  return {
    body: stdout.slice(0, idx),
    status: parseInt(stdout.slice(idx + 1), 10) || 0,
  };
}
