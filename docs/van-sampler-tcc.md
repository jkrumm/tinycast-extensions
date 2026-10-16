# van-sampler outside Tinycast — the Bluetooth TCC question

The van sampler used to be a Tinycast no-view background command (every 15 min). Tinycast ran it
only while no view was open, and it died with the app. It is now a launchd job
(`launchd/com.jkrumm.van-sampler.plist.tmpl`, `extension/scripts/van-sampler.ts`, wrapped in
`jobrun`). The one open risk is macOS Bluetooth privacy (TCC): the BLE scan happens in `van-ble`,
and until now Tinycast Beta was the process the grant belonged to. This page is the research, the
spike that decides it, and the fallback. **Status: built, not proven. The spike can only run on the
MacBook (BLE hardware, GUI session, a human to click the dialog).**

## What the research says (2026-10-16, research-gateway, standard depth)

| Question | Finding | Confidence |
|-|-|-|
| Whose grant does a launchd job use? | The **agent's own program** is the responsible process, not launchd. Children inherit it: `fork`/`posix_spawn` copy `p_responsible_pid`, `exec` keeps it, only `responsibility_spawnattrs_setdisclaim` resets it. An interpreter wrapper (`/bin/bash`) stays responsible for what it runs. | high (kernel behaviour, Quinn/Apple DTS, Qt and Ghostty write-ups) |
| Usage description in a bare binary? | Missing `NSBluetoothAlwaysUsageDescription` = **SIGABRT** at the first CoreBluetooth call. CFBundle falls back to the `__TEXT,__info_plist` section for a bundle-less executable, so an `.app` is not required *by the lookup*. | high for the abort, medium for the embedded section |
| Does that yield a prompt + persistent grant for a launchd CLI? | **Unsettled.** One developer-forum report: a CLI with the embedded section is still killed from a plain command-line launch and prompts only under the debugger. Likely an attribution matter, not established. | low — this is the spike |
| What is the grant keyed by? | The stored **designated requirement** (`csreq`), not the path. Ad-hoc code's DR is `cdhash H"…"`: every rebuild with changed bytes loses the grant. A certificate-anchored DR (Apple Development / Developer ID) survives rebuilds; switching between the two variants re-prompts. | high (TN3127, Quinn) |
| Background session? | Bluetooth is user-level TCC and needs a **logged-in GUI session**; a request from a background session is refused, not prompted. A LaunchAgent in the Aqua session can be prompted; whether a UI-less one is, is undocumented. | high / open |
| macOS 15 / 26 change? | None found for Bluetooth + LaunchAgents (15's new control was local-network privacy). | medium |

Consequences designed in:

- **`van-ble --supervise -- <cmd>`** is the launchd *program*. It `posix_spawn`s the job (jobrun →
  bun → `van-ble` again for the scan) and waits. It never `exec`s: that would swap the attributed
  binary for `jobrun`/`bun`, which carry no usage description.
- The binary lives at a fixed path, `~/.local/libexec/van-sampler/van-ble`, rebuilt only when its
  source, `Info.plist` or signing identity changed (`scripts/van-sampler-build.sh`), so an unchanged
  rebuild keeps its cdhash and its grant.
- Signing prefers an `Apple Development` identity; with none it signs ad-hoc and says so (grant lost
  on every rebuild that changes bytes — acceptable for a rarely rebuilt helper, but a real cost).
- Tinycast keeps its own bare `assets/van-ble` for the foreground read in the Van Power view; that
  path still rides on Tinycast's grant and is untouched.

## The spike — `make van-sampler-spike`

Runs on the MacBook, logged in, at the screen. It quits Tinycast Beta (and reopens it after), then
runs three throwaway launchd jobs against the real signed binary and ends with exactly one line,
`VAN-SAMPLER SPIKE: PASS` (exit 0) or `VAN-SAMPLER SPIKE: FAIL (<why>)` (exit 1). Evidence:
`~/Library/Logs/van-sampler-spike.result` (+ `.log`).

| Step | launchd program | Pass condition |
|-|-|-|
| A1 | `van-ble --tcc-probe --wait-prompt` | macOS shows the Bluetooth dialog (click Allow); probe reports `allowedAlways`, `poweredOn`, scan ran |
| A2 | `van-ble --tcc-probe` | no dialog; `initialAuthorization` is already `allowedAlways` — the grant persisted |
| B | `van-ble --supervise -- env bun -e <spawn van-ble --tcc-probe>` | the grandchild behind an interpreter starts `allowedAlways` — the production chain shape shares the grant. `jobrun` itself is not in the chain (it would write a state record); it is another bun process, the same exec boundary |

A job that dies with `signal: Abort trap: 6` fails A1 with the abort named: the embedded usage
description was not honoured. `make van-sampler-setup` runs `scripts/van-sampler-gate.sh`, which refuses
unless the result file ends in `PASS` **and** records the sha256 of the installed binary (a rebuild, or a
harness run with `VAN_SPIKE_BIN`, invalidates it). `make van-sampler-notify-test` writes its own result file.

The harness mechanics (verdict lines, abort detection, a grandchild that does not share the grant)
were exercised on the mini against fake binaries; the real BLE outcome was not, because the mini is
not the machine that holds the van's devices or a Bluetooth grant.

## Fallback if the spike fails — an `.app` bundle

Do not patch around a failure; switch the attributed identity to a bundle, which is the documented
shape for TCC clients:

1. `scripts/van-sampler-build.sh` assembles `~/Applications/VanSampler.app/Contents/{Info.plist,MacOS/van-ble}`
   (a real `CFBundleExecutable`, `CFBundleIdentifier com.jkrumm.van-sampler`, `LSUIElement true`,
   the same `NSBluetoothAlwaysUsageDescription`), signed as a bundle (`codesign --deep`).
2. The launchd plist's program becomes `…/VanSampler.app/Contents/MacOS/van-ble --supervise -- …`
   and gains `AssociatedBundleIdentifiers = com.jkrumm.van-sampler` (Quinn's fix for an agent that is
   not attributed to its app).
3. Re-run the same spike steps against the bundle path. If the bare binary failed only at A2/B
   (grant not persisted / not inherited) rather than A1, try step 2 alone first.
4. If that fails too, the last resort is the status quo: Tinycast's own background command, which
   this move deleted — `git revert` the migration commit. Nothing else depends on the daemon.

## What changed besides the process

State moved from Tinycast `LocalStorage` to files under `~/.local/state/van-sampler/` so the daemon
and the Van Power view share one store (pause is a UI-owned flag file there). The capture and trend
logs the SoC estimator and the daily consumption read stay in Tinycast's support dir, unchanged.

## Accepted trade-offs and rollback

- **`--supervise` is a general wrapper.** Any process running as the user can run a command under the
  signed binary's Bluetooth grant; the binary sits in a user-writable path. Accepted: the same user
  can already drive Tinycast's grant, and an allowlist would hard-code the jobrun/bun paths into a
  signed artefact. Revisit if the binary ever gets a broader entitlement.
- **Two BLE clients.** An open Van Power view and the daemon can scan at the same moment; the BMS takes
  one connection, so one side can read "Phone app holds the battery" for that tick. The stores are
  atomic-rename files (last writer wins; the Victron cache re-reads before saving).
- **Rollback.** `make van-sampler-teardown`, then `git revert` the migration commit and `make deploy`
  (the Tinycast command returns; enable Background refresh again). The first Van Power open after the
  move removed the Tinycast LocalStorage keys; the history ring and trends are rebuilt by the next
  reads, the logs (`van-log.jsonl`, `van-trends.jsonl`) are untouched.
- **Remove `van/legacy.ts` and the view's `migrated` gate** once the MacBook has opened Van Power on
  the new build once (its LocalStorage keys are gone).
- **Signing identity.** Auto-detect takes the first `Apple Development` identity; set `SIGN_IDENTITY`
  explicitly if there are several, or the designated requirement (and the grant) can change.
