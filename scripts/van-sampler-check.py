#!/usr/bin/env python3
"""Health check for the launchd van sampler (`extension/scripts/van-sampler.ts`).

Reads what the sampler persisted — its state file (`sampler.json` in
~/.local/state/van-sampler/, VAN_SAMPLER_DIR overrides), the `paused` flag file
the Van Power view owns, and the `source: "background"` lines in van-log.jsonl
(VAN_SUPPORT_DIR overrides the Tinycast support dir) — and judges the latest run:

  ok        a background reading landed (Ective SoC, Victron advert or not)
  idle      ran, but the van was not in range / Bluetooth off (not a failure)
  paused    the flag file exists; a paused run returns at once (not a failure)
  FAIL      no state file, an `error` result, a `sampled` result without its
            log line, or no run for interval + 10 min

Each report also prints the last Victron trends top-up from the sampler state
(time + ok/failed/pairing); that line is informational, it never fails a run.

`--wait N` blocks until N more runs happened after the current one (polls the
state's lastRunAt), checking each, then exits 0 if all were ok/idle, 1 if any
failed, 2 on timeout. A run is overdue when none lands within interval + 10 min
(is the launchd job loaded? `launchctl print gui/$UID/com.jkrumm.van-sampler`).

stdlib only, run via `make van-sampler-check` (ARGS="--wait 2").
"""

from __future__ import annotations


import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

INTERVAL_S = 15 * 60
OVERDUE_GRACE_S = 10 * 60
POLL_S = 30

STATE_DIR = Path(os.environ.get("VAN_SAMPLER_DIR") or Path.home() / ".local" / "state" / "van-sampler")
STATE_FILE = STATE_DIR / "sampler.json"
PAUSED_FILE = STATE_DIR / "paused"
SUPPORT_DIR = Path(
    os.environ.get("VAN_SUPPORT_DIR")
    or Path.home() / "Library" / "Application Support" / "com.tinycast.app.beta" / "extension-support" / "jkrumm"
)
VAN_LOG = SUPPORT_DIR / "van-log.jsonl"


def local(unix_s: float) -> str:
    return datetime.fromtimestamp(unix_s).strftime("%Y-%m-%d %H:%M:%S")


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def sampler_state() -> dict | None:
    state = load_json(STATE_FILE)
    return state if isinstance(state, dict) else None


def last_run_unix(state: dict | None) -> float | None:
    raw = (state or {}).get("lastRunAt")
    return raw / 1000 if isinstance(raw, (int, float)) else None


def background_lines(since_unix: float) -> list[dict]:
    if not VAN_LOG.exists():
        return []
    out = []
    for line in VAN_LOG.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("source") == "background" and entry["t"] / 1000 >= since_unix:
            out.append(entry)
    return out


def judge(state: dict | None, run_unix: float | None) -> tuple[bool, str]:
    """(ok, one-line verdict) for the most recent run."""
    if PAUSED_FILE.exists():
        return True, "paused (the flag file exists; runs return at once)"
    if state is None:
        return False, f"FAIL — no readable {STATE_FILE} (has the job run? `launchctl print gui/$UID/com.jkrumm.van-sampler`)"
    if run_unix is None:
        return False, "never ran"
    age = time.time() - run_unix
    if age > INTERVAL_S + OVERDUE_GRACE_S:
        return False, f"FAIL — last run {int(age // 60)} min ago (overdue: the job should run every {INTERVAL_S // 60} min)"
    result = state.get("lastResult") or {}
    kind = result.get("kind")
    if kind == "error":
        return False, f"FAIL — error result: {result.get('message')}"
    if kind == "sampled":
        captured = background_lines(run_unix - 60)
        if not captured:
            return False, f"FAIL — state says sampled ({result.get('soc')} %) but no background line in van-log.jsonl"
        c = captured[-1]
        victron = "victron ✓" if c.get("victron") else "victron —"
        return True, f"ok — SoC {c['ective']['soc']} %, {c['ective']['currentA']} A, {victron}"
    return True, f"idle — {kind}: {json.dumps(result)}"


def trends_line(state: dict | None) -> str:
    """The sampler's last Victron trends top-up (informational, never a failure)."""
    last = (state or {}).get("lastTrends")
    if not last:
        return "Victron trends top-up: none yet (needs the cache over 3 h old and the charger in range)"
    detail = f" — {last['detail']}" if last.get("detail") else ""
    line = f"Victron trends top-up: {local(last['at'] / 1000)} {last.get('outcome')}{detail}"
    backoff = (state or {}).get("trendsBackoffUntil")
    if backoff and backoff / 1000 > time.time():
        line += f" (pairing backoff until {local(backoff / 1000)})"
    return line


def report() -> tuple[bool, float | None]:
    state = sampler_state()
    run_unix = last_run_unix(state)
    ok, verdict = judge(state, run_unix)
    when = local(run_unix) if run_unix else "—"
    print(f"{when}  {verdict}")
    print(f"  {trends_line(state)}")
    return ok, run_unix


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wait", type=int, default=0, help="block until N more runs, checking each")
    args = parser.parse_args()

    ok, last = report()
    all_ok = ok
    seen = 0
    while seen < args.wait:
        deadline = (last or time.time()) + INTERVAL_S + OVERDUE_GRACE_S
        while True:
            run_unix = last_run_unix(sampler_state())
            if run_unix and (last is None or run_unix > last):
                break
            if time.time() > deadline:
                print(f"OVERDUE — no run since {local(last) if last else 'ever'}; "
                      "is the launchd job loaded, or the Mac asleep?")
                return 2
            time.sleep(POLL_S)
        time.sleep(5)  # let the run finish writing state + log
        ok, last = report()
        all_ok = all_ok and ok
        seen += 1

    background = background_lines(time.time() - 24 * 3600)
    print(f"background readings in the last 24 h: {len(background)}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
