#!/usr/bin/env python3
"""Health check for the `van-sampler` background command.

Reads what Tinycast Beta persisted — the command metadata (last run, failures,
subtitle), the sampler's LocalStorage state (`van-sampler`) and the
`source: "background"` lines in van-log.jsonl — and judges each run:

  ok        a background reading landed (Ective SoC, Victron advert or not)
  idle      ran, but the van was not in range / Bluetooth off (not a failure)
  FAIL      consecutiveFailures > 0, lastError set, or an `error` result

Each report also prints the last Victron trends top-up from the sampler state
(time + ok/failed/pairing); that line is informational, it never fails a run.

`--wait N` blocks until N more runs happened after the current one (polls the
metadata's lastRun), checking each, then exits 0 if all were ok/idle, 1 if any
failed, 2 on timeout. A run is overdue when no run lands within interval +
10 min: Tinycast never runs a background command while any foreground command
is open (tinycast skill § background), so close Tinycast's window with Esc.

stdlib only, run via `make van-sampler-check` (ARGS="--wait 2").
"""

from __future__ import annotations


import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

EXTENSION_NAME = "jkrumm"
COMMAND = "van-sampler"
INTERVAL_S = 15 * 60
OVERDUE_GRACE_S = 10 * 60
POLL_S = 30
APPLE_EPOCH_OFFSET_SECONDS = 978307200

APP_SUPPORT = Path.home() / "Library" / "Application Support" / "com.tinycast.app.beta"
COMMANDS_FILE = APP_SUPPORT / "extension-commands.json"
DATA_FILE = APP_SUPPORT / "extension-data" / f"{EXTENSION_NAME}.json"
VAN_LOG = APP_SUPPORT / "extension-support" / EXTENSION_NAME / "van-log.jsonl"


def local(unix_s: float) -> str:
    return datetime.fromtimestamp(unix_s).strftime("%Y-%m-%d %H:%M:%S")


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def metadata() -> dict:
    data = load_json(COMMANDS_FILE) or {}
    return data.get(EXTENSION_NAME, {}).get(COMMAND, {})


def last_run_unix(meta: dict) -> float | None:
    raw = meta.get("lastRun")
    return raw + APPLE_EPOCH_OFFSET_SECONDS if raw is not None else None


def sampler_state() -> dict | None:
    data = load_json(DATA_FILE) or {}
    raw = data.get("localStorage", {}).get(COMMAND)
    if isinstance(raw, dict) and "string" in raw:
        raw = raw["string"].get("_0")
    try:
        return json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        return None


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


def judge(meta: dict, state: dict | None, run_unix: float | None) -> tuple[bool, str]:
    """(ok, one-line verdict) for the most recent run."""
    if not meta.get("backgroundEnabled"):
        return False, "background refresh is OFF (Tinycast → Settings → Extensions → Van Sampler)"
    if run_unix is None:
        return False, "never ran"
    failures = meta.get("consecutiveFailures", 0)
    if failures or meta.get("lastError"):
        return False, f"FAIL — consecutiveFailures={failures} lastError={meta.get('lastError')!r}"
    if state is None:
        return False, "FAIL — no van-sampler LocalStorage state"
    if state.get("paused"):
        return True, "paused (run returned at once)"
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
    meta = metadata()
    state = sampler_state()
    run_unix = last_run_unix(meta)
    ok, verdict = judge(meta, state, run_unix)
    when = local(run_unix) if run_unix else "—"
    print(f"{when}  {verdict}   [subtitle: {meta.get('subtitle', '—')}]")
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
            run_unix = last_run_unix(metadata())
            if run_unix and (last is None or run_unix > last):
                break
            if time.time() > deadline:
                print(f"OVERDUE — no run since {local(last) if last else 'ever'}; "
                      "is a Tinycast command window open (Esc closes it) or the Mac asleep?")
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
