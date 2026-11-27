// The one impure call of the scan and print commands: spawn `~/.local/bin/paper`
// (a zsh wrapper around the paper CLI; the pattern of home/run.ts). paper prints
// one JSON line, also on a refusal (exit 1), so stdout is returned whatever the
// exit code was; a crash or a timeout is "" and reads as "paper did not answer".

import { execFile } from "child_process";
import { homedir } from "os";
import { PATH } from "../usage/local";

export const PAPER_BIN = `${homedir()}/.local/bin/paper`;

// Port: stdout of `paper <args>`; never rejects.
export type RunPaper = (args: string[], timeoutMs: number) => Promise<string>;

export const runPaper: RunPaper = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      PAPER_BIN,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH },
      },
      (_error, stdout) => resolve(String(stdout ?? "")),
    );
  });
