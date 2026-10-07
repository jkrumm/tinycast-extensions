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
    opts?: { secretFields?: Record<string, string> },
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
    // Secrets (the admin password, PINs, PUKs, APN passwords) never go on
    // argv, where `ps` could see them — they're passed as a curl config
    // read from stdin (`-K -`) instead, one `data-urlencode` line per field.
    const secretEntries = Object.entries(opts?.secretFields ?? {});
    let configStdin: string | undefined;
    if (secretEntries.length > 0) {
      configStdin =
        secretEntries
          .map(
            ([name, value]) =>
              `data-urlencode = "${escapeCurlConfigValue(name, value)}"`,
          )
          .join("\n") + "\n";
      args.push("-K", "-");
    }
    args.push(url);
    return runCurl(args, configStdin);
  }
}

// curl config-file syntax: a value is a double-quoted string where `\` and
// `"` must be backslash-escaped. Newlines would break the one-line-per-field
// format, so they're rejected outright rather than silently mangled.
function escapeCurlConfigValue(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `secretFields value for "${name}" must not contain newlines`,
    );
  }
  return `${name}=${value}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
