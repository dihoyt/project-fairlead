#!/bin/sh
# Joins more machines to this host's k3s cluster over SSH: installs Longhorn's
# node prerequisites (open-iscsi, NFS client) on each, then k3s at this
# server's version, as an agent or (--server) another server, and waits until
# the node is Ready. Run on a k3s server node, as root or with sudo.
#
#   curl -sfL <raw URL>/add-node.sh | sudo sh -s -- user@10.0.0.21 user@10.0.0.22
#
# The join token never reaches a command line, the terminal or a log: it
# travels inside the script piped to the target's sh over SSH.
set -eu
# shellcheck disable=SC3040
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

TOKEN_FILE="/var/lib/rancher/k3s/server/node-token"
K3S_KUBECONFIG="/etc/rancher/k3s/k3s.yaml"

AS_SERVER=0
SSH_KEY=""
SSH_PORT=""
SERVER_URL=""
TIMEOUT="300s"
TARGETS=""

usage() {
  cat <<EOF
Joins machines to this host's k3s cluster over SSH.

Usage: add-node.sh [flags] user@host [user@host ...]

  --server              Join as an additional server (needs embedded etcd) instead of an agent
  --server-url URL      How the new nodes reach this server (default: https://<this host's IP>:6443)
  --ssh-key PATH        SSH private key to log in with
  --ssh-port PORT       SSH port on the targets (default: 22)
  --timeout DURATION    How long to wait for each node to be Ready (default: $TIMEOUT)
  -h, --help            Show this help

Each target needs SSH access as root, or as a user with passwordless sudo,
and outbound HTTPS to fetch packages and k3s.
EOF
}

say() { printf '%s\n' "$*"; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

need_arg() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value"; fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) AS_SERVER=1; shift ;;
    --server-url) need_arg "$@"; SERVER_URL="$2"; shift 2 ;;
    --ssh-key) need_arg "$@"; SSH_KEY="$2"; shift 2 ;;
    --ssh-port) need_arg "$@"; SSH_PORT="$2"; shift 2 ;;
    --timeout) need_arg "$@"; TIMEOUT="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown flag $1 (see --help)" ;;
    *)
      case "$1" in *[!A-Za-z0-9@._:-]*) die "not a user@host target: $1" ;; esac
      TARGETS="$TARGETS $1"
      shift
      ;;
  esac
done

[ -n "$TARGETS" ] || { usage >&2; exit 1; }
case "$SERVER_URL" in
  "") ;;
  *[!A-Za-z0-9.:/_-]*) die "--server-url must be a plain URL: $SERVER_URL" ;;
  https://*) ;;
  *) die "--server-url must start with https://" ;;
esac
case "$SSH_PORT" in *[!0-9]*) die "--ssh-port must be a number" ;; esac
[ -z "$SSH_KEY" ] || [ -r "$SSH_KEY" ] || die "cannot read $SSH_KEY"
case "$TIMEOUT" in *[!0-9smh]*) die "--timeout must be a duration like 300s or 5m" ;; esac

[ "$(id -u)" = 0 ] || die "run as root (sudo): the join token is readable by root only"
has k3s || die "k3s is not installed here; run this on a k3s server node"
[ -r "$TOKEN_FILE" ] || die "no $TOKEN_FILE; run this on a k3s server node, not an agent"
has ssh || die "ssh is required"

VERSION=$(k3s --version 2>/dev/null | sed -n 's/^k3s version \([^ ]*\).*/\1/p')
case "$VERSION" in
  v1.[0-9]*+k3s[0-9]*) ;;
  *) die "could not read this server's k3s version" ;;
esac
if [ "$AS_SERVER" = 1 ] && [ ! -d /var/lib/rancher/k3s/server/db/etcd ]; then
  die "this server keeps its state in SQLite; another server can only join a k3s started with --cluster-init (embedded etcd)"
fi
if [ -z "$SERVER_URL" ]; then
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
  [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | awk '{ print $1 }')
  [ -n "$ip" ] || die "could not find this host's IP; pass --server-url"
  SERVER_URL="https://$ip:6443"
fi

kube() { k3s kubectl --kubeconfig "$K3S_KUBECONFIG" "$@"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

ssh_to() {
  target="$1"
  shift
  set -- -o ConnectTimeout=10 "$target" "$@"
  [ -z "$SSH_PORT" ] || set -- -p "$SSH_PORT" "$@"
  [ -z "$SSH_KEY" ] || set -- -i "$SSH_KEY" -o IdentitiesOnly=yes "$@"
  ssh "$@"
}

# The script each target runs, with the token and version filled in. Written
# owner-only and fed to the target's sh on stdin.
write_join_script() {
  role="$1"
  (
    umask 077
    {
      printf 'set -eu\n'
      printf 'K3S_URL=%s\nK3S_TOKEN=%s\nINSTALL_K3S_VERSION=%s\n' "'$SERVER_URL'" "'$(cat "$TOKEN_FILE")'" "'$VERSION'"
      printf 'export K3S_URL K3S_TOKEN INSTALL_K3S_VERSION\nROLE=%s\n' "$role"
      cat <<'REMOTE'
has() { command -v "$1" >/dev/null 2>&1; }
if has iscsiadm && { has mount.nfs || [ -x /sbin/mount.nfs ] || [ -x /usr/sbin/mount.nfs ]; }; then
  echo "open-iscsi and the NFS client are already installed."
elif has apt-get; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq open-iscsi nfs-common >/dev/null
elif has dnf; then
  dnf install -y -q iscsi-initiator-utils nfs-utils >/dev/null
elif has yum; then
  yum install -y -q iscsi-initiator-utils nfs-utils >/dev/null
elif has zypper; then
  zypper --non-interactive --quiet install open-iscsi nfs-client >/dev/null
elif has apk; then
  apk add --quiet open-iscsi nfs-utils >/dev/null
else
  echo "warning: no known package manager; install open-iscsi and an NFS client yourself" >&2
fi
if has systemctl; then
  systemctl enable --now iscsid >/dev/null 2>&1 || echo "warning: could not start iscsid" >&2
elif has rc-update; then
  { rc-update add iscsid && rc-service iscsid start; } >/dev/null 2>&1 || echo "warning: could not start iscsid" >&2
fi
has curl || { echo "error: curl is required on this node" >&2; exit 1; }
installer=$(mktemp)
curl -sfL "https://raw.githubusercontent.com/k3s-io/k3s/$INSTALL_K3S_VERSION/install.sh" -o "$installer" \
  || { echo "error: could not download the k3s installer" >&2; exit 1; }
# k3s reads K3S_URL and K3S_TOKEN from the environment for both roles.
sh "$installer" "$ROLE" >/dev/null
rm -f "$installer"
REMOTE
    } >"$TMP/join.sh"
  )
}

join() {
  target="$1"
  say "== $target"
  uid=$(ssh_to "$target" id -u </dev/null) || die "could not log in to $target over SSH"
  if [ "$uid" = 0 ]; then
    run_as="sh -s"
  else
    ssh_to "$target" sudo -n true </dev/null 2>/dev/null \
      || die "sudo on $target needs a password; use root or give that user passwordless sudo"
    run_as="sudo -n sh -s"
  fi
  name=$(ssh_to "$target" hostname </dev/null | tr -d '\r')
  [ -n "$name" ] || die "could not read the hostname of $target"
  if kube get node "$name" >/dev/null 2>&1; then
    say "$name is already in the cluster; skipping."
    return 0
  fi
  say "Installing prerequisites and k3s $VERSION on $name ..."
  ssh_to "$target" "$run_as" <"$TMP/join.sh" || die "joining $target failed (see the output above)"
  say "Waiting for $name to be Ready ..."
  i=0
  until kube get node "$name" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 60 ] || die "$name did not register with the cluster"
    sleep 2
  done
  kube wait --for=condition=Ready "node/$name" --timeout="$TIMEOUT" >/dev/null || die "$name registered but is not Ready"
  say "$name is Ready."
}

if [ "$AS_SERVER" = 1 ]; then role=server; else role=agent; fi
write_join_script "$role"
for target in $TARGETS; do join "$target"; done
say ""
kube get nodes -o wide
