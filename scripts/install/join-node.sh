#!/bin/sh
# Prepares a machine as a k3s node and joins it: installs Longhorn's node
# prerequisites (open-iscsi with iscsid running, an NFS client), then k3s.
# Runs as root on the new node with the join details in the environment:
#
#   K3S_URL               https://<server>:6443
#   K3S_TOKEN             the cluster's join token
#   INSTALL_K3S_VERSION   the server's k3s version, e.g. v1.36.5+k3s1
#   ROLE                  agent (default) or server
#
# add-node.sh carries a copy of the part between the markers (CI checks they
# match), so anything that serves a join script can serve this file.
set -eu
: "${K3S_URL:?}" "${K3S_TOKEN:?}" "${INSTALL_K3S_VERSION:?}"
ROLE="${ROLE:-agent}"
export K3S_URL K3S_TOKEN INSTALL_K3S_VERSION
# --- join begin
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
# --- join end
