// The impure half of the Scanner view: every call into `scan-cli` (read the
// status, the documents and their thumbnails; submit, discard, release; start a
// scan), the preferences, the log path. The component (`scanner.tsx`) only calls
// these, so the e2e suite mocks this one module.

import { getPreferenceValues } from "@raycast/api";
import { homedir } from "os";
import { join } from "path";
import { Preferences } from "../lib/preferences";
import { directArgs, runScanCommand, ScanCommandPorts } from "./actions";
import { cliPorts, runCli } from "./cli-run";
import { ScanMode } from "./escl";
import { parseResultLine } from "./parse";
import { stateDirOf } from "./state-dir";
import {
  DocThumb,
  DocumentsResult,
  parseDocThumbs,
  parseDocuments,
  parseStatus,
  ScanStatus,
} from "./view";

export interface ActionResult {
  ok: boolean;
  message: string;
}

const STATUS_TIMEOUT_MS = 10_000;
const DOCUMENTS_TIMEOUT_MS = 30_000;
const DOC_THUMBS_TIMEOUT_MS = 120_000;
const ACTION_TIMEOUT_MS = 60_000;

const prefs = (): Preferences => getPreferenceValues<Preferences>();

const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

// `--out-dir`, `--brain-dir`, `--dokumente-dir` from the preferences; null
// without an inbox.
function inboxArgs(): string[] | null {
  const p = prefs();
  const inbox = p.scanInbox?.trim();
  if (!inbox) return null;
  const brain = p.scanBrainDir?.trim();
  const dokumente = p.scanDokumenteDir?.trim();
  return [
    "--out-dir",
    inbox,
    ...(brain ? ["--brain-dir", expandHome(brain)] : []),
    ...(dokumente ? ["--dokumente-dir", expandHome(dokumente)] : []),
  ];
}

const NO_INBOX = "Set the scan inbox in the extension preferences";

export async function loadStatus(): Promise<ScanStatus> {
  const status = parseStatus(await runCli(["--status"], STATUS_TIMEOUT_MS));
  if (!status) throw new Error("The scan tool did not answer");
  return status;
}

export async function loadDocuments(): Promise<DocumentsResult> {
  const args = inboxArgs();
  if (!args) return { ok: false, message: NO_INBOX };
  return parseDocuments(
    await runCli(["--documents", ...args], DOCUMENTS_TIMEOUT_MS),
  );
}

export async function loadDocThumbs(): Promise<DocThumb[]> {
  const args = inboxArgs();
  if (!args) return [];
  return parseDocThumbs(
    await runCli(["--doc-thumbs", ...args], DOC_THUMBS_TIMEOUT_MS),
  );
}

async function direct(
  action: "submit" | "discard",
  force = false,
): Promise<ActionResult> {
  const args = directArgs(action, prefs(), force);
  if (!args) return { ok: false, message: NO_INBOX };
  return parseResultLine(await runCli(args, ACTION_TIMEOUT_MS));
}

// `force`: file although the last Scan More failed.
export const submitScan = (force = false): Promise<ActionResult> =>
  direct("submit", force);
export const discardScan = (): Promise<ActionResult> => direct("discard");

// File a document the consumer held in review/ as one document.
export async function releaseDocument(name: string): Promise<ActionResult> {
  const inbox = prefs().scanInbox?.trim();
  if (!inbox) return { ok: false, message: NO_INBOX };
  return parseResultLine(
    await runCli(
      ["--release", name, "--as", "single", "--out-dir", inbox],
      ACTION_TIMEOUT_MS,
    ),
  );
}

// The pre-check, then the detached scan: what the launcher commands do, with
// the HUD line returned as the result instead of shown.
export async function startScan(mode: ScanMode): Promise<ActionResult> {
  let message = "";
  const ports: ScanCommandPorts = {
    ...cliPorts,
    hud: async (text) => {
      message = text;
    },
  };
  const started = await runScanCommand(mode, ports);
  return { ok: started, message };
}

export const scanLogPath = (): string =>
  join(stateDirOf(process.env, homedir()), "scan.log");
