---
name: print
description: The one way to print a file on the Mac's printer from an agent: the print CLI (print-cli), its flags, the one-line JSON contract, the device's capabilities and what it cannot do. Use whenever a document has to be printed, a print job checked or cancelled, or the printer's state or toner read. Never hand-write an lp command.
---

# Print

THE one way to print for agents. Run the bundled CLI; never build an `lp` or
`cancel` command by hand (the CLI checks the queue, sets every option
explicitly, and keeps the cancel scope to the current user).

```bash
bun extension/assets/print-cli.js <file> [flags]     # after: make print-cli
make -C <repo> print ARGS="<file> [flags]"           # from source, no bundle
```

Every call prints ONE JSON line. Exit 0 on `ok: true`, 1 on a failure, 2 on a
usage error (bad flag or value; the message says which).

## Flags

| Flag | Meaning |
|-|-|
| `<file>` | one file: pdf, png, jpg, jpeg, tif, tiff or txt; must exist |
| `--pages 1-3,5,8-` | page list (digits, ranges, commas; open end allowed; ascending not required) |
| `--copies N` | 1–99 (the device allows 9999; the CLI caps it on purpose) |
| `--simplex` | one-sided (default is two-sided, long edge) |
| `--short-edge` | two-sided, short edge |
| `--n-up N` | 1, 2, 4, 6, 9 or 16 pages per sheet |
| `--quality draft\|normal\|high` | print quality |
| `--media A4\|A5\|A6\|Letter\|Legal` | paper size (default A4) |
| `--manual-feed` | feed from the manual tray |
| `--printer <queue>` | CUPS queue (default: the system default printer) |
| `--hold` | hold the job until released (then `--cancel` it) |
| `--wait [seconds]` | wait for the job's end (default 300); reports the final state |
| `--dry-run` | run the check, return the `lp` argv, submit nothing |
| `--check` | the queue: state, accepting, toner, queued jobs |
| `--status [<jobId>]` | printer state, toner and active jobs, or one job |
| `--cancel <jobId>` | cancel one job (`<queue>-<n>`) |
| `--cancel-all` | cancel the current user's active jobs on the queue |
| `--help` | plain-text usage |

## JSON contract

- Print: `{ ok, action: "print", jobId, printer, file, sides, pages, copies, warnings, message }`; with `--wait` also `state`.
- Dry run: `{ ok, action: "dry-run", printer, file, argv, warnings }`.
- Check: `{ ok, printer, state, accepting, reasons, tonerPercent, tonerLow, queued, warnings }`.
- Status: `{ ok, printer, state, accepting, reasons, tonerPercent, tonerLow, warnings, jobs: [{ id, title, state, reasons, user, submittedAt, sheets }] }`; with a job id `{ ok, job }`.
- Cancel: `{ ok, cancelled: [ids], message }`.
- Failure: `{ ok: false, message }`. A refusal names the reason in one line (no printer, not accepting, stopped, unknown queue, bad file).

`warnings` (toner low, other printer reasons) never refuse a job.

## Device capabilities

The queue is a mono laser, driverless (AirPrint/IPP). Reads come from `ipptool`; the values below are what the device reports.

| Capability | Value |
|-|-|
| Colour | monochrome only (no colour option) |
| Sides | one-sided, two-sided long edge (default), two-sided short edge |
| Copies | 1–9999 on the device; the CLI allows 1–99 |
| Page ranges | yes (`-P`) |
| Pages per sheet | 1, 2, 4, 6, 9, 16 |
| Quality | draft, normal, high (the device is 600 dpi only) |
| Media | A4 (default), A5, A6, Letter, Legal, envelopes, labels (the CLI exposes the first five) |
| Input | auto, manual, tray 1 (the CLI exposes `--manual-feed`) |
| Toner | level and low threshold readable; a warning state `toner-low-warning` |

## What the device cannot do

- Colour output, or any colour option.
- Toner save (no such option; do not look for one).
- Resolution above 600 dpi.
- Any print that bypasses the queue check (the CLI always checks first).

## Rules for agents

- Dry-run first when you are unsure: `--dry-run` shows the exact `lp` argv and submits nothing.
- Never print in a test or a proof. A live proof is `--dry-run`, `--check`, `--status`, or `--hold` followed by `--cancel`.
- The printer is a shared device: confirm the file and the page list before a real submit.
- Cancel only your own jobs; `--cancel-all` never touches another user's.

## From the mini

The mini has its own queue for the same printer (same capabilities) and a checkout of this
repo, so an agent there prints without the MacBook and without a dialog:

```
bun ~/SourceRoot/tinycast-extensions/extension/scripts/print.ts <file> [flags]
```

The script has no dependencies (no `bun install`, no build) and uses the machine's default
queue. Same flags, same JSON line. Check first with `--check`; prove a change with `--dry-run`
or `--hold` followed by `--cancel <jobId>`, never with a real page. A `print` command on PATH
for both machines belongs in dotfiles and is not built yet.
