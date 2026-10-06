#!/usr/bin/env bash
# Starts the operator's own Chrome for HAAS, with remote debugging on a dedicated profile.
# Chrome 136+ ignores --remote-debugging-port on the default profile, so the profile dir is required.
set -euo pipefail

PORT="${HAAS_CDP_PORT:-9222}"
PROFILE="${HAAS_CHROME_PROFILE:-$HOME/.haas/chrome-profile}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [ ! -x "$CHROME" ]; then
  echo "Chrome not found at: $CHROME (set CHROME_BIN)" >&2
  exit 1
fi

if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "Chrome is already listening on port $PORT. Nothing to start."
  exit 0
fi

mkdir -p "$PROFILE"
nohup "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  about:blank >/dev/null 2>&1 &
disown || true

cat <<MSG
Started Chrome with remote debugging on http://127.0.0.1:$PORT
Profile: $PROFILE

Next:
  1. In that Chrome window, log into Fiverr (and PeoplePerHour / Guru if you use them).
  2. Leave the window open while HAAS runs. HAAS uses one tab, one site at a time.
  3. If a site shows a human check, solve it yourself in that window; HAAS only waits.
  4. Check it: pnpm smoke:browser fiverr "logo design"
MSG
