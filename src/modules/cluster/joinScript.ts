import type { JoinRole } from "../../contracts/cluster.js";

export interface JoinValues {
  role: JoinRole;
  serverUrl: string;
  token: string;
  k3sVersion: string;
  // Hostnames already in the cluster: k3s refuses a second node by the same
  // name, and says so only in the agent's journal.
  nodeNames: string[];
}

const TOKEN = /^[A-Za-z0-9:._-]{8,512}$/;
const VERSION = /^v\d+\.\d+\.\d+\+k3s\d+$/;
const NODE_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

// Every value goes into the script inside single quotes; these checks keep a
// quote (or anything else a shell would act on) out of them.
export function validServerUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(url.host)) return null;
  return url.origin;
}

export const validToken = (value: string) => TOKEN.test(value);
export const validVersion = (value: string) => VERSION.test(value);

export function joinScript(values: JoinValues): string {
  const serverUrl = validServerUrl(values.serverUrl);
  if (!serverUrl || !validToken(values.token) || !validVersion(values.k3sVersion)) {
    throw new Error("Join values failed validation.");
  }
  const names = values.nodeNames.filter((name) => NODE_NAME.test(name)).join(" ");
  const what = values.role === "server" ? "server (control plane)" : "agent";
  return `#!/usr/bin/env bash
# Joins this machine to the cluster as a k3s ${what}, k3s ${values.k3sVersion}.
# This link has now been used; make a new one to add another machine.
set -euo pipefail

K3S_URL='${serverUrl}'
K3S_VERSION='${values.k3sVersion}'
EXISTING_NODES='${names}'

fail() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root: curl -fsSL '<link>' | sudo bash (the link works once; make a new one)."
[ "$(uname -s)" = "Linux" ] || fail "k3s runs on Linux only."
if command -v k3s >/dev/null 2>&1 || [ -e /etc/systemd/system/k3s.service ] || [ -e /etc/systemd/system/k3s-agent.service ]; then
  fail "k3s is already installed here. To re-join, run k3s-agent-uninstall.sh (or k3s-uninstall.sh) first."
fi
name="$(hostname | tr '[:upper:]' '[:lower:]')"
for existing in $EXISTING_NODES; do
  [ "$existing" = "$name" ] && fail "the cluster already has a node named $name. Change this machine's hostname first."
done

echo "==> Checking that $K3S_URL is reachable"
curl -ks --max-time 10 -o /dev/null "$K3S_URL/cacerts" || fail "can't reach $K3S_URL from here (firewall, or the address in the join Secret)."

echo "==> Installing storage packages (open-iscsi, nfs)"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq open-iscsi nfs-common >/dev/null
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q iscsi-initiator-utils nfs-utils
elif command -v yum >/dev/null 2>&1; then
  yum install -y -q iscsi-initiator-utils nfs-utils
elif command -v zypper >/dev/null 2>&1; then
  zypper --non-interactive --quiet install open-iscsi nfs-client
else
  echo "warning: no known package manager; install open-iscsi and an NFS client yourself for Longhorn and NFS volumes." >&2
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now iscsid >/dev/null 2>&1 || true
fi

echo "==> Installing k3s $K3S_VERSION as ${values.role}"
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" K3S_URL="$K3S_URL" K3S_TOKEN='${values.token}' sh -s - ${values.role}

echo "==> Done. $name appears in the nodes list once it is Ready."
`;
}
