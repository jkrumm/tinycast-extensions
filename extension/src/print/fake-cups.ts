// An in-process CUPS for tests only: answers each tool from `answers` and
// records every call, so no test can reach a real queue. Never imported by the
// CLI or the Tinycast commands.

import { createCups, CupsPorts, ExecResult } from "./cups";
import { LP_REQUEST_ID } from "./fixtures";

export interface FakeAnswers {
  defaultDestination: string;
  printer: () => string;
  jobs: () => string;
  job: () => string;
  lpCode?: number;
  lpStderr?: string;
}

export interface FakeCall {
  file: string;
  args: string[];
}

export function fakeCups(answers: FakeAnswers) {
  const calls: FakeCall[] = [];
  const files = new Map<string, string>();
  let clock = 0;
  const ports: CupsPorts = {
    user: "user",
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    tempFile: (text) => {
      const path = `/tmp/fake-${files.size}.test`;
      files.set(path, text);
      return { path, remove: () => files.delete(path) };
    },
    exec: async (file, args): Promise<ExecResult> => {
      calls.push({ file, args });
      if (file === "lpstat") {
        return { code: 0, stdout: answers.defaultDestination, stderr: "" };
      }
      if (file === "ipptool") {
        const test = files.get(args[2]) ?? "";
        const text = test.includes("Get-Printer-Attributes")
          ? answers.printer()
          : test.includes("Get-Jobs")
            ? answers.jobs()
            : answers.job();
        return { code: 0, stdout: text, stderr: "" };
      }
      if (file === "lp") {
        return {
          code: answers.lpCode ?? 0,
          stdout: LP_REQUEST_ID,
          stderr: answers.lpStderr ?? "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { cups: createCups(ports), calls, files };
}
