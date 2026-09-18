#!/usr/bin/env bash
# Renders og.html into site/og.png (1200x630), the preview picture shown when secretary.my.id is shared.
# Needs a Chrome or Chromium on this machine; set CHROME to point at one if it is somewhere unusual.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

chrome="${CHROME:-}"
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "$(command -v google-chrome 2>/dev/null || true)" \
  "$(command -v chromium 2>/dev/null || true)" \
  "$(command -v chromium-browser 2>/dev/null || true)"; do
  [ -z "$chrome" ] && [ -n "$candidate" ] && [ -x "$candidate" ] && chrome="$candidate"
done
[ -n "$chrome" ] || { echo "Chrome tidak ditemukan. Set CHROME=/path/ke/chrome." >&2; exit 1; }

"$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --virtual-time-budget=4000 --window-size=1200,630 \
  --screenshot="$here/../site/og.png" "file://$here/og.html" >/dev/null 2>&1
echo "og.png ditulis: $here/../site/og.png"
