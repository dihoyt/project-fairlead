#!/bin/sh
# Writes update.sh from install.sh: the same script with MODE="update", so a
# curl | sh one-liner works for each without fetching the other. With --check,
# fails instead when update.sh is out of date (CI).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
grep -q '^MODE="install"$' "$root/install.sh" || { echo "install.sh has no MODE=\"install\" line"; exit 1; }
generated=$(sed 's/^MODE="install"$/MODE="update"/' "$root/install.sh")
if [ "${1:-}" = --check ]; then
  [ "$generated" = "$(cat "$root/update.sh")" ] || { echo "update.sh is out of date: run scripts/install/gen-update.sh"; exit 1; }
  echo "ok: update.sh matches install.sh"
else
  printf '%s\n' "$generated" >"$root/update.sh"
  chmod +x "$root/update.sh"
fi
