#!/bin/sh
# Writes the KERIA agency config from the environment, then starts KERIA.
#   KERIA_PUBLIC_URL   URL wallets reach the KERIA http (OOBI) port at, e.g. https://keria.example.app/
#                      (agent OOBIs handed to wallets are built from it)
#   KERIA_IURLS        optional ;-separated witness/introduction OOBIs resolved by every agent
#   KERIA_DURLS        optional ;-separated data OOBIs (schemas) resolved by every agent
# KERIA 0.4 does not build agent OOBIs from the KERIA_CURLS variable alone, hence the file.
set -eu
: "${KERIA_PUBLIC_URL:=http://127.0.0.1:3902/}"
case "$KERIA_PUBLIC_URL" in */) ;; *) KERIA_PUBLIC_URL="$KERIA_PUBLIC_URL/" ;; esac
list() { printf '%s' "${1:-}" | awk -v RS=';' 'NF { gsub(/^[ \t]+|[ \t\n]+$/, ""); printf "%s\"%s\"", (n++ ? "," : ""), $0 }'; }
DT="2026-01-01T00:00:00.000000+00:00"
mkdir -p /keria/config/keri/cf
cat > /keria/config/keri/cf/keria.json <<JSON
{"dt":"$DT","keria":{"dt":"$DT","curls":["$KERIA_PUBLIC_URL"]},"iurls":[$(list "${KERIA_IURLS:-}")],"durls":[$(list "${KERIA_DURLS:-}")]}
JSON
echo "keria config: $(cat /keria/config/keri/cf/keria.json)"
exec keria start --config-dir /keria/config --config-file keria --loglevel "${KERIA_LOG_LEVEL:-INFO}" "$@"
