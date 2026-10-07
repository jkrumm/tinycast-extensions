#!/bin/bash
# Real screenshot of a deployed command: opens it through its deeplink, waits,
# captures the screen and crops to the Tinycast window (centred horizontally,
# 750 x 475 pt at interfaceSize "standard"; generous margin vertically).
#   scripts/screenshot.sh <command> [wait-seconds] [out-name]
# Output: /tmp/shots/<out-name>.png, downscaled to 1600 px wide for reading.
# Needs "Screen Recording" for the terminal; never scrolls (no accessibility).
set -euo pipefail
command_name="${1:?usage: screenshot.sh <command> [wait-seconds] [out-name]}"
wait_s="${2:-6}"
out="${3:-$command_name}"
mkdir -p /tmp/shots
open "tinycast://extensions/jkrumm/jkrumm/${command_name}"
sleep "$wait_s"
screencapture -x "/tmp/shots/${out}-full.png"
width=$(sips -g pixelWidth "/tmp/shots/${out}-full.png" | awk '/pixelWidth/ {print $2}')
crop_w=1640   # 750 pt window + margin, at 2x
crop_x=$(( (width - crop_w) / 2 ))
sips --cropToHeightWidth 1060 "$crop_w" --cropOffset 470 "$crop_x" \
  "/tmp/shots/${out}-full.png" --out "/tmp/shots/${out}.png" >/dev/null
sips -Z 1600 "/tmp/shots/${out}.png" >/dev/null
rm "/tmp/shots/${out}-full.png"
echo "/tmp/shots/${out}.png"
