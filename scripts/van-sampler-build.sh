#!/usr/bin/env bash
# Build the SIGNED van-ble that launchd runs as the van-sampler program.
#   - the source is helpers/van-ble/main.swift; Info.plist (NSBluetoothAlwaysUsageDescription) is
#     embedded with -sectcreate __TEXT __info_plist;
#   - signed with a stable identity when one exists (an ad-hoc DR is a cdhash, so every rebuild
#     would invalidate the Bluetooth grant — see docs/van-sampler-tcc.md);
#   - installed at a FIXED path, replaced only when source/plist/identity changed, so an
#     unchanged rebuild keeps the same cdhash and the same grant.
# SIGN_IDENTITY overrides auto-detection ("-" = ad-hoc).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/extension/helpers/van-ble/main.swift"
plist="$root/extension/helpers/van-ble/Info.plist"
dest_dir="${VAN_SAMPLER_BIN_DIR:-$HOME/.local/libexec/van-sampler}"
dest="$dest_dir/van-ble"
ident_id="com.jkrumm.van-sampler"

identity="${SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  identity="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1)"
fi
if [ -z "$identity" ]; then
  identity="-"
  echo "WARNING: no code-signing identity found; signing ad-hoc. The Bluetooth grant is bound to this build's cdhash and is lost on every rebuild with changed bytes." >&2
fi

stamp="$(cat "$src" "$plist" | shasum -a 256 | cut -d' ' -f1)-$identity"
mkdir -p "$dest_dir"
if [ -x "$dest" ] && [ "$(cat "$dest_dir/.build-stamp" 2>/dev/null)" = "$stamp" ] && codesign --verify "$dest" 2>/dev/null; then
  echo "van-ble (signed) up to date: $dest"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
swiftc -O -o "$tmp/van-ble" "$src" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$plist"
codesign --force --sign "$identity" --identifier "$ident_id" "$tmp/van-ble"
"$tmp/van-ble" --selftest >/dev/null || { echo "selftest failed" >&2; exit 1; }

mv -f "$tmp/van-ble" "$dest.new"
mv -f "$dest.new" "$dest"
printf '%s' "$stamp" > "$dest_dir/.build-stamp"
echo "van-ble (signed, $([ "$identity" = "-" ] && echo ad-hoc || echo "$identity")) installed: $dest"
codesign -d -r- "$dest" 2>&1 | sed -n 's/^# //p'
