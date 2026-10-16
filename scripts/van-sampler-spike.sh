#!/usr/bin/env bash
# The Bluetooth TCC spike for van-sampler: does a launchd job whose PROGRAM is the signed van-ble
# (embedded Info.plist) get a Bluetooth grant attributed to it, with Tinycast quit, and does a
# CHILD of it (via --supervise, the production chain) share that grant?
#
#   A1  launchd -> van-ble --tcc-probe --wait-prompt   macOS shows the Bluetooth dialog; ANSWER "Allow"
#   A2  launchd -> van-ble --tcc-probe                 grant persisted: no dialog, authorization already allowed
#   B   launchd -> van-ble --supervise -- sh -c 'van-ble --tcc-probe'    the grandchild is attributed to the same grant
#
# Prints one verdict line, `VAN-SAMPLER SPIKE: PASS` or `VAN-SAMPLER SPIKE: FAIL (<why>)`, and exits
# 0 / 1. Evidence goes to ~/Library/Logs/van-sampler-spike.result. Run on the MacBook, in the logged-in
# GUI session (a launchd agent in a background session is refused, not prompted).
#   --notify    instead: post the low-battery-style notification from a launchd job and ask whether it showed
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bin="${VAN_SPIKE_BIN:-$HOME/.local/libexec/van-sampler/van-ble}"  # override: harness tests only
label="com.jkrumm.van-sampler-spike"
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/van-sampler-spike.log"
result="$HOME/Library/Logs/van-sampler-spike.result"
domain="gui/$(id -u)"
exitfile="$(mktemp)"
tinycast_was_running=0

say() { printf '%s\n' "$*" | tee -a "$result"; }
fail() { say "VAN-SAMPLER SPIKE: FAIL ($*)"; exit 1; }  # the EXIT trap cleans up

cleanup() {
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  if [ "$tinycast_was_running" = 1 ]; then open -a "Tinycast Beta" 2>/dev/null || true; fi
}
trap cleanup EXIT

# run_job <wait-seconds> <program> [args...] -> prints the job's log; the exit code lands in $exitfile
run_job() {
  local wait_s="$1"; shift
  : > "$log"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    printf '<plist version="1.0"><dict><key>Label</key><string>%s</string><key>ProgramArguments</key><array>' "$label"
    for a in "$@"; do printf '<string>%s</string>' "$(printf '%s' "$a" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"; done
    printf '</array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>%s</string><key>StandardErrorPath</key><string>%s</string></dict></plist>\n' "$log" "$log"
  } > "$plist"
  plutil -lint "$plist" >/dev/null || fail "could not render the spike plist"
  launchctl bootout "$domain/$label" 2>/dev/null || true
  launchctl bootstrap "$domain" "$plist" || fail "launchctl bootstrap failed (no GUI session?)"
  local i=0 info
  while [ "$i" -lt "$wait_s" ]; do
    info="$(launchctl print "$domain/$label" 2>/dev/null)"
    # bootstrap returns before the RunAtLoad launch (state = xpcproxy, runs = 1 while it starts):
    # finished = launchd recorded an exit code or a terminating signal
    if printf '%s' "$info" | grep -Eq 'last exit code = [0-9]|last terminating signal'; then break; fi
    sleep 1; i=$((i + 1))
  done
  # run_job's output is captured with $(...), so the exit code travels through a file
  launchctl print "$domain/$label" 2>/dev/null | sed -n -e 's/.*last exit code = //p' -e 's/.*last terminating signal = /signal: /p' | paste -sd' ' - > "$exitfile"
  launchctl bootout "$domain/$label" 2>/dev/null || true
  cat "$log"
}

field() { printf '%s' "$1" | /usr/bin/python3 -c 'import json,sys
d=json.loads(sys.stdin.read().strip().splitlines()[-1]); v=d.get(sys.argv[1]); print(str(v).lower() if isinstance(v,bool) else v)' "$2" 2>/dev/null; }

check_probe() { # <name> <output> <expect-initial>
  local name="$1" out="$2" expect="$3" line
  line="$(printf '%s\n' "$out" | grep '"probe"' | tail -1)"
  [ -n "$line" ] || fail "$name produced no probe line (job: $(cat "$exitfile"); a Bluetooth abort shows as signal Abort trap: 6 — the embedded usage description was not honoured). Log: $log"
  say "  $name: $line"
  [ "$(field "$line" ok)" = true ] || fail "$name: probe not ok (failure=$(field "$line" failure), authorization=$(field "$line" finalAuthorization))"
  if [ -n "$expect" ] && [ "$(field "$line" initialAuthorization)" != "$expect" ]; then
    fail "$name: started as $(field "$line" initialAuthorization), expected $expect"
  fi
}

: > "$result"
say "van-sampler spike $(date '+%F %T')  host=$(hostname -s)  macOS=$(sw_vers -productVersion)"

if [ "${1:-}" = "--notify" ]; then
  out="$(run_job 20 /usr/bin/osascript -e 'display notification "van-sampler notification test" with title "Van battery"')"
  say "notify job exit: $(cat "$exitfile") ${out}"
  [ "$(cat "$exitfile")" = 0 ] || fail "osascript failed from launchd"
  say "NOTIFY: posted — confirm a 'Van battery' banner appeared (System Settings → Notifications → Script Editor must allow it)."
  exit 0
fi

[ -x "$bin" ] || "$root/scripts/van-sampler-build.sh" || fail "build failed"
say "binary: $bin"
say "signature: $(codesign -d -r- "$bin" 2>&1 | sed -n 's/^# //p')"
if codesign -dvv "$bin" 2>&1 | grep -q 'Signature=adhoc'; then
  say "NOTE: ad-hoc signed — the grant is bound to this cdhash; a rebuild with changed bytes re-prompts."
fi

if pgrep -f "Tinycast Beta" >/dev/null 2>&1; then
  tinycast_was_running=1
  say "quitting Tinycast Beta for the test (it is reopened afterwards)"
  osascript -e 'quit app "Tinycast Beta"' >/dev/null 2>&1 || true
  sleep 3
  pgrep -f "Tinycast Beta" >/dev/null 2>&1 && fail "Tinycast Beta would not quit — the test needs it closed"
fi

say "A1 launchd program = signed van-ble. If macOS asks for Bluetooth access, click Allow (waits up to 2 min)…"
out="$(run_job 140 "$bin" --tcc-probe --wait-prompt)"
check_probe A1 "$out" ""

say "A2 same program again, no prompt allowed (persisted grant)…"
out="$(run_job 40 "$bin" --tcc-probe)"
check_probe A2 "$out" allowedAlways

say "B  production chain: van-ble --supervise -> sh -> van-ble (grandchild must share the grant)…"
out="$(run_job 40 "$bin" --supervise -- /bin/sh -c "\"$bin\" --tcc-probe")"
check_probe B "$out" allowedAlways

say "VAN-SAMPLER SPIKE: PASS"
