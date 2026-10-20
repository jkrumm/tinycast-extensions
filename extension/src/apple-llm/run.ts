// The only impure part: spawn the apple-llm helper (bare binary in assets/, like
// van-ble) with one JSON request on stdin. `spawn`, not `execFile`, because
// Tinycast's child_process shim exposes `stdin` only on a spawned child.
import { environment } from "@raycast/api";
import { spawn } from "child_process";
import { join } from "path";
import { LlmReply, parseLlmReply } from "./parse";

const TIMEOUT_MS = 60_000;

export function translate(texts: string[], to = "English"): Promise<LlmReply> {
  return runHelper({ mode: "translate", texts, to });
}

export function runHelper(request: object): Promise<LlmReply> {
  return new Promise((resolve) => {
    const child = spawn(join(environment.assetsPath, "apple-llm"), []);
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, available: true, error: "apple-llm timed out" });
    }, TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, available: true, error: e.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(parseLlmReply(stdout));
      } catch (e) {
        resolve({ ok: false, available: true, error: String(e) });
      }
    });
    // The helper may exit before reading stdin (dyld failure, missing binary).
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
}
