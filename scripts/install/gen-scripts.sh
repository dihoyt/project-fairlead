#!/bin/sh
# Writes the scripts that are copies of others, so each works as a curl | sh
# one-liner on its own:
#   update.sh   install.sh with MODE="update"
#   add-node.sh carries scripts/install/join-node.sh's join section
# With --check, fails instead when either is out of date (CI).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
check=0
[ "${1:-}" != --check ] || check=1
status=0

emit() {
  if [ "$check" = 1 ]; then
    if [ "$2" = "$(cat "$root/$1")" ]; then
      echo "ok: $1"
    else
      echo "$1 is out of date: run scripts/install/gen-scripts.sh"
      status=1
    fi
  else
    printf '%s\n' "$2" >"$root/$1"
    chmod +x "$root/$1"
  fi
}

grep -q '^MODE="install"$' "$root/install.sh" || { echo "install.sh has no MODE=\"install\" line"; exit 1; }
emit update.sh "$(sed 's/^MODE="install"$/MODE="update"/' "$root/install.sh")"

join=$(sed -n '/^# --- join begin$/,/^# --- join end$/p' "$root/scripts/install/join-node.sh" | sed '1d;$d')
[ -n "$join" ] || { echo "join-node.sh has no join section"; exit 1; }
emit add-node.sh "$(JOIN="$join" awk '
  /^REMOTE$/ { skip = 0 }
  !skip { print }
  /cat <<.REMOTE.$/ { print ENVIRON["JOIN"]; skip = 1 }
' "$root/add-node.sh")"

exit "$status"
