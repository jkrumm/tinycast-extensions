#!/usr/bin/env bash
# The install gate for the van-sampler LaunchAgent: succeeds only when the Bluetooth spike passed for
# THIS installed binary. Says which condition failed. VAN_SAMPLER_FORCE=1 skips it.
set -euo pipefail
bin="$HOME/.local/libexec/van-sampler/van-ble"
result="$HOME/Library/Logs/van-sampler-spike.result"

[ "${VAN_SAMPLER_FORCE:-}" = 1 ] && { echo "gate skipped (VAN_SAMPLER_FORCE=1)"; exit 0; }
no() { echo "No usable spike result: $* — run 'make van-sampler-spike' (VAN_SAMPLER_FORCE=1 overrides)." >&2; exit 1; }

[ -x "$bin" ] || no "binary $bin missing"
[ -f "$result" ] || no "$result missing"
[ "$(tail -1 "$result")" = "VAN-SAMPLER SPIKE: PASS" ] || no "last line of $result is not PASS: $(tail -1 "$result")"
want="$(sed -n 's/^binary-sha256: //p' "$result" | head -1)"
have="$(shasum -a 256 "$bin" | cut -d' ' -f1)"
[ -n "$want" ] && [ "$want" = "$have" ] || no "the spike tested a different binary than the installed one (rebuilt, or run with VAN_SPIKE_BIN)"
echo "gate ok: spike PASS for $have"
