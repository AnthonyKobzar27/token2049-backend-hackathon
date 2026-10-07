#!/usr/bin/env bash
# Starts the operator's own Chrome for HAAS, with remote debugging on a dedicated profile.
# Chrome 136+ ignores --remote-debugging-port on the default profile, so the profile dir is required.
set -euo pipefail
# Modes:
#   (default) hidden   a normal Chrome whose window is hidden (macOS); HAAS shows it only when a site
#                      asks for a human check. Sites see a regular browser.
#   --show             visible; use it once to log into Fiverr / PeoplePerHour / Guru (the profile keeps it).
#   --headless         no window at all. Some sites (Fiverr) challenge headless browsers more often.
MODE="${HAAS_CHROME_MODE:-hidden}"
for arg in "$@"; do
  case "$arg" in
    --show) MODE=show ;;
    --headless) MODE=headless ;;
    --hidden) MODE=hidden ;;
  esac
done
SHOW=0; [ "$MODE" = "show" ] && SHOW=1

PORT="${HAAS_CDP_PORT:-9222}"
PROFILE="${HAAS_CHROME_PROFILE:-$HOME/.haas/chrome-profile}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [ ! -x "$CHROME" ]; then
  echo "Chrome not found at: $CHROME (set CHROME_BIN)" >&2
  exit 1
fi

VERSION="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/json/version" 2>/dev/null || true)"
if [ -n "$VERSION" ]; then
  if printf '%s' "$VERSION" | grep -q '"Browser": *"\(Headless\)\?Chrome/'; then
    echo "Chrome is already listening on port $PORT. Nothing to start."
    exit 0
  fi
  # Something else (e.g. Adobe UXP) owns the port.
  echo "Port $PORT is taken by another program, not Chrome. Use another port:" >&2
  echo "  HAAS_CDP_PORT=9333 $0   and set CHROME_CDP_URL=http://127.0.0.1:9333" >&2
  exit 1
fi

mkdir -p "$PROFILE"
HEADLESS_FLAGS=()
if [ "$MODE" = "headless" ]; then
  # A normal window size and user agent so sites serve the same pages as to a person.
  VERSION_NUM="$("$CHROME" --version 2>/dev/null | grep -Eo '[0-9]+' | head -1)"
  HEADLESS_FLAGS=(--headless=new --window-size=1366,900 --disable-blink-features=AutomationControlled
    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${VERSION_NUM:-140}.0.0.0 Safari/537.36")
fi
nohup "$CHROME" \
  ${HEADLESS_FLAGS[@]+"${HEADLESS_FLAGS[@]}"} \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  about:blank >/dev/null 2>&1 &
disown || true

if [ "$MODE" = "hidden" ] && [ "$(uname)" = "Darwin" ]; then
  # Hide the window once Chrome is up (HAAS reveals it during a human check).
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    PID="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
    [ -n "$PID" ] && break
    sleep 0.5
  done
  if [ -n "${PID:-}" ]; then
    sleep 1
    osascript -e "tell application \"System Events\" to set visible of (first process whose unix id is $PID) to false" >/dev/null 2>&1 || true
  fi
fi

if [ "$SHOW" = "1" ]; then
cat <<MSG
Started Chrome (visible) with remote debugging on http://127.0.0.1:$PORT
Profile: $PROFILE

Next:
  1. In that window, log into Fiverr, PeoplePerHour and Guru (HAAS messages freelancers from these accounts).
  2. Quit Chrome, then run this script again without --show: HAAS then searches and messages hidden.
  3. If a site later shows a human check, HAAS asks you; run with --show to solve it.
MSG
else
cat <<MSG
Started Chrome ($MODE) with remote debugging on http://127.0.0.1:$PORT
Profile: $PROFILE
Searches and messages run in the background; the window appears only if a site asks for a human check.
Not logged into Fiverr / PeoplePerHour / Guru yet? Quit this Chrome and run: $0 --show
MSG
fi
