#!/usr/bin/env bash
# Checks an install from the installer's own output: the printed URL answers,
# serves the client, and the admin password signs in.
# Usage: assert-install.sh <installer output> <password>
set -euo pipefail

log=${1:?installer output}
password=${2:?admin password}
url=$(sed -n 's/^URL: //p' "$log" | tail -n 1)
[ -n "$url" ] || { echo "no URL in the installer output"; exit 1; }

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
[ "$(code "${url}healthz")" = 200 ] || { echo "${url}healthz is not 200"; exit 1; }
[ "$(code "$url")" = 200 ] || { echo "$url does not serve the client"; exit 1; }
[ "$(code "${url}api/system/modules")" = 401 ] || { echo "unauthenticated /api is not refused"; exit 1; }
status=$(code -X POST -H 'content-type: application/json' \
  --data "{\"username\":\"admin\",\"password\":\"$password\"}" "${url}api/auth/login")
[ "$status" = 200 ] || { echo "admin sign-in answered $status"; exit 1; }
echo "ok: $url answers and the admin password signs in"
