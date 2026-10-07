#!/usr/bin/env python3
"""Debug readout for the `jkrumm` Tinycast extension.

Reads Tinycast Beta's own persisted state — background command metadata,
the netgear-watchdog LocalStorage event log, the tail of the extension's
own netgear.log, LocalStorage key sizes, and a
deployed-vs-built sha1 check — since `console.log` is compiled out of the
release app (see .claude/skills/tinycast/SKILL.md § Debugging). Never prints
`preferences` (may contain secrets).

stdlib only, run via `make status`.
"""

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

EXTENSION_NAME = "jkrumm"
BUNDLE_ID = "com.tinycast.app.beta"
APPLE_EPOCH_OFFSET_SECONDS = 978307200  # 2001-01-01T00:00:00Z, unix seconds
WATCHDOG_LOG_LIMIT = 60

APP_SUPPORT = Path.home() / "Library" / "Application Support" / BUNDLE_ID
COMMANDS_FILE = APP_SUPPORT / "extension-commands.json"
DATA_FILE = APP_SUPPORT / "extension-data" / f"{EXTENSION_NAME}.json"
NETGEAR_LOG = APP_SUPPORT / "extension-support" / EXTENSION_NAME / "netgear.log"
NETGEAR_LOG_TAIL = 25
INSTALLED_EXT_DIR = APP_SUPPORT / "extensions" / EXTENSION_NAME
REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = REPO_ROOT / "extension" / "build"


def apple_epoch_to_local(seconds: float) -> str:
    unix_seconds = seconds + APPLE_EPOCH_OFFSET_SECONDS
    return (
        datetime.fromtimestamp(unix_seconds, tz=timezone.utc)
        .astimezone()
        .strftime("%Y-%m-%d %H:%M:%S")
    )


def unix_ms_to_local(ms: float) -> str:
    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .astimezone()
        .strftime("%Y-%m-%d %H:%M:%S")
    )


def load_json(path: Path):
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def unwrap_local_storage_value(raw):
    """LocalStorage values are sometimes wrapped as {"string":{"_0":"<json>"}}
    (a Swift enum's JSON encoding) and sometimes stored raw. Return the
    decoded JSON value, or the raw string if it doesn't parse."""
    value = raw
    if isinstance(value, dict) and "string" in value:
        inner = value["string"]
        if isinstance(inner, dict) and "_0" in inner:
            value = inner["_0"]
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def raw_value_size(raw) -> int:
    """Byte size of the value as Tinycast persists it, before unwrapping."""
    return len(json.dumps(raw, ensure_ascii=False).encode("utf-8"))


def print_command_metadata():
    print("== Command metadata (extension-commands.json) ==")
    data = load_json(COMMANDS_FILE)
    commands = (data or {}).get(EXTENSION_NAME)
    if not commands:
        print(f"  no entries for extension '{EXTENSION_NAME}'")
        return
    for name, meta in sorted(commands.items()):
        last_run = meta.get("lastRun")
        last_run_str = apple_epoch_to_local(last_run) if last_run else "never"
        background = "on" if meta.get("backgroundEnabled") else "off"
        print(f"  {name}")
        print(f"    subtitle:            {meta.get('subtitle', '—')}")
        print(f"    background refresh:  {background}")
        print(f"    last run:            {last_run_str}")
        print(f"    consecutiveFailures: {meta.get('consecutiveFailures', 0)}")
        print(f"    lastError:           {meta.get('lastError') or '—'}")


def print_watchdog_events(local_storage: dict):
    print()
    print("== netgear-watchdog log (newest first, routine ticks collapsed) ==")
    raw = local_storage.get("netgear-watchdog")
    if raw is None:
        print("  no netgear-watchdog entry yet")
        return
    storage = unwrap_local_storage_value(raw)
    if not isinstance(storage, dict):
        print("  unexpected shape, skipping")
        return
    print(f"  enabled: {storage.get('enabled')}")
    print(f"  state:   {json.dumps(storage.get('state', {}))}")
    counts = storage.get("counts") or {}
    if storage.get("since"):
        summary = " · ".join(f"{k} {v}" for k, v in sorted(counts.items()))
        print(f"  since:   {unix_ms_to_local(storage['since'])} — {summary}")
    events = storage.get("events", [])[:WATCHDOG_LOG_LIMIT]
    if not events:
        print("  no events logged yet")
        return
    for event in events:
        at = event.get("at")
        when = unix_ms_to_local(at) if at else "?"
        if event.get("firstAt"):
            when = f"{unix_ms_to_local(event['firstAt'])} – {when[-8:]}"
        times = f" ×{event['count']}" if event.get("count") else ""
        kind = f"{event.get('kind', '?')}{times}"
        print(f"  {when}  {kind:<15} {event.get('message', '')}")


def print_netgear_log():
    print()
    print(f"== netgear.log (last {NETGEAR_LOG_TAIL} lines, newest last) ==")
    if not NETGEAR_LOG.exists():
        print(f"  no log yet ({NETGEAR_LOG})")
        return
    lines = NETGEAR_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
    if not lines:
        print("  empty")
        return
    for line in lines[-NETGEAR_LOG_TAIL:]:
        print(f"  {line}")


def print_local_storage_sizes(local_storage: dict):
    print()
    print("== LocalStorage key sizes ==")
    if not local_storage:
        print("  (empty)")
        return
    for key, raw in sorted(local_storage.items()):
        size = raw_value_size(raw)
        print(f"  {key}: {size} bytes")


def print_speed_test_history_count(local_storage: dict):
    print()
    print("== speed-test history ==")
    raw = local_storage.get("speed-test-history")
    if raw is None:
        print("  no history yet")
        return
    history = unwrap_local_storage_value(raw)
    count = len(history) if isinstance(history, list) else "?"
    print(f"  entries: {count}")


def sha1_of(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()


def print_deploy_check():
    print()
    print("== Deployed vs built (extension/build/*.js) ==")
    if not BUILD_DIR.exists():
        print(f"  not built yet — run 'make build' ({BUILD_DIR} missing)")
        return
    if not INSTALLED_EXT_DIR.exists():
        print(f"  not installed yet — {INSTALLED_EXT_DIR} missing")
        return

    built_js = sorted(BUILD_DIR.glob("*.js"))
    if not built_js:
        print("  no built .js files found")
        return

    stale = False
    for built_file in built_js:
        installed_file = INSTALLED_EXT_DIR / built_file.name
        if not installed_file.exists():
            print(f"  missing installed copy of {built_file.name}")
            stale = True
            continue
        if sha1_of(built_file) != sha1_of(installed_file):
            print(f"  sha1 mismatch: {built_file.name}")
            stale = True

    if stale:
        print("  deployed: STALE (run make deploy)")
    else:
        print("  deployed: up to date")


def main() -> int:
    print_command_metadata()

    data = load_json(DATA_FILE) or {}
    local_storage = data.get("localStorage", {})
    print_watchdog_events(local_storage)
    print_netgear_log()
    print_local_storage_sizes(local_storage)
    print_speed_test_history_count(local_storage)
    print_deploy_check()
    return 0


if __name__ == "__main__":
    sys.exit(main())
