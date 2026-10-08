#!/bin/sh
# Installs or upgrades the console in a Kubernetes cluster: the current kube
# context if one answers, else an existing k3s on this host, else a fresh
# single-node k3s. Installs Helm when it is missing. Re-running upgrades in
# place. Run with --help for the flags.
#
#   curl -sfL <raw URL>/install.sh | sh -
#   curl -sfL <raw URL>/install.sh | sh -s -- --host console.example.test
set -eu
# Not POSIX, but every sh this runs under (dash, bash, busybox ash) has it.
# shellcheck disable=SC3040
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

DISPLAY_NAME="Fairlead" # brand:generated displayName
SLUG="fairlead" # brand:generated slug
DEFAULT_NAMESPACE="fairlead" # brand:generated defaultNamespace
CHART_NAME="fairlead" # brand:generated chartName
IMAGE_REGISTRY="ghcr.io/dihoyt" # brand:generated imageRegistry
OWNER_LABEL="fairlead" # brand:generated ownerLabelDomain

# A fresh k3s is the stable channel's newest release, read at install time;
# this pin is used only when the channel can't be read.
K3S_VERSION="v1.36.5+k3s1"
K3S_CHANNEL_URL="https://update.k3s.io/v1-release/channels/stable"
HELM_VERSION="v3.16.2"
HELM_SHA256_AMD64="9318379b847e333460d33d291d4c088156299a26cd93d570a7f5d0c36e50b5bb"
HELM_SHA256_ARM64="1888301aeb7d08a03b6d9f4d2b73dcd09b89c41577e80e3455c113629fc657a4"
K3S_KUBECONFIG="/etc/rancher/k3s/k3s.yaml"

NAMESPACE="$DEFAULT_NAMESPACE"
RELEASE="$SLUG"
CHART_VERSION=""
IMAGE_TAG=""
CHART_REF=""
HOST=""
ORIGIN=""
INGRESS_CLASS=""
VALUES_FILES=""
KUBECONFIG_PATH=""
NO_K3S=0
YES=0
DRY_RUN=0
UNINSTALL=0
NODE_PACKAGES=1
ENABLE_DEPLOY=0
PURGE=0
TIMEOUT="5m"
NODE_PORT=""
DEFAULT_NODE_PORT=32450

usage() {
  cat <<EOF
Installs or upgrades $DISPLAY_NAME in a Kubernetes cluster.

Usage: install.sh [flags]

  --namespace NS        Namespace (default: $DEFAULT_NAMESPACE)
  --release NAME        Helm release name (default: $SLUG)
  --version VERSION     Chart version (default: the newest published, including edge builds)
  --image-tag TAG       Image tag (default: the chart's appVersion)
  --chart REF           Chart to install: a local directory or an oci:// reference
                        (default: oci://$IMAGE_REGISTRY/charts/$CHART_NAME)
  --host HOST           Serve through an Ingress at this hostname instead of a NodePort
  --origin URL          Externally visible origin (default: http://HOST when --host is given)
  --ingress-class NAME  Ingress class (default: the cluster's default class)
  --port PORT           NodePort to serve on without --host (default: $DEFAULT_NODE_PORT)
  --values FILE         Extra Helm values file; repeatable, applied last
  --enable-deploy       Let the console deploy apps from its catalog. Creates an installer
                        ServiceAccount bound to cluster-admin; off unless given
  --kubeconfig PATH     Use this kubeconfig instead of detecting a cluster
  --no-k3s              Never install k3s; fail if no cluster is found
  --no-node-packages    Don't install open-iscsi and the NFS client on this host's k3s node
  --timeout DURATION    How long to wait for the rollout (default: $TIMEOUT)
  --yes                 Don't ask before installing k3s or changing a cluster
  --dry-run             Print the changes instead of making them
  --uninstall           Remove the release; keeps the namespace, its Secret and the data volume
  --purge               With --uninstall, also delete the namespace and everything in it
  -h, --help            Show this help

While the registry is private, set REGISTRY_USER and REGISTRY_TOKEN (a token
with read:packages) in the environment to pull the chart and image.
EOF
}

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

# Mutating commands go through run so --dry-run can print them instead.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ %s\n' "$*" >&2
  else
    "$@"
  fi
}

need_arg() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value"; fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --namespace) need_arg "$@"; NAMESPACE="$2"; shift 2 ;;
    --release) need_arg "$@"; RELEASE="$2"; shift 2 ;;
    --version) need_arg "$@"; CHART_VERSION="$2"; shift 2 ;;
    --image-tag) need_arg "$@"; IMAGE_TAG="$2"; shift 2 ;;
    --chart) need_arg "$@"; CHART_REF="$2"; shift 2 ;;
    --host) need_arg "$@"; HOST="$2"; shift 2 ;;
    --origin) need_arg "$@"; ORIGIN="$2"; shift 2 ;;
    --ingress-class) need_arg "$@"; INGRESS_CLASS="$2"; shift 2 ;;
    --port) need_arg "$@"; NODE_PORT="$2"; shift 2 ;;
    --values)
      need_arg "$@"
      [ -r "$2" ] || die "cannot read values file $2"
      VALUES_FILES="$VALUES_FILES$2
"
      shift 2
      ;;
    --kubeconfig) need_arg "$@"; KUBECONFIG_PATH="$2"; shift 2 ;;
    --timeout) need_arg "$@"; TIMEOUT="$2"; shift 2 ;;
    --enable-deploy) ENABLE_DEPLOY=1; shift ;;
    --no-k3s) NO_K3S=1; shift ;;
    --no-node-packages) NODE_PACKAGES=0; shift ;;
    --yes | -y) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown flag $1 (see --help)" ;;
  esac
done

# Everything below lands in YAML or a resource name, so only plain characters.
dns_label() {
  case "$2" in
    "" | -* | *- | *[!a-z0-9-]*) die "$1 must be a lowercase DNS label: $2" ;;
  esac
}
dns_label --namespace "$NAMESPACE"
dns_label --release "$RELEASE"
case "$HOST" in *[!A-Za-z0-9.-]*) die "--host must be a hostname: $HOST" ;; esac
case "$ORIGIN" in
  "") ;;
  *[!A-Za-z0-9.:/_-]*) die "--origin must be a plain URL: $ORIGIN" ;;
  http://* | https://*) ;;
  *) die "--origin must start with http:// or https://" ;;
esac
case "$IMAGE_TAG" in *[!A-Za-z0-9._-]*) die "--image-tag has unexpected characters: $IMAGE_TAG" ;; esac
case "$INGRESS_CLASS" in *[!a-z0-9.-]*) die "--ingress-class has unexpected characters" ;; esac
case "$NODE_PORT" in
  "") ;;
  *[!0-9]*) die "--port must be a number: $NODE_PORT" ;;
  *) if [ "$NODE_PORT" -lt 30000 ] || [ "$NODE_PORT" -gt 32767 ]; then die "--port must be in the NodePort range 30000-32767"; fi ;;
esac
[ -z "$NODE_PORT" ] || [ -z "$HOST" ] || die "--port is for the NodePort install; --host serves through an Ingress"
[ "$PURGE" = 0 ] || [ "$UNINSTALL" = 1 ] || die "--purge only goes with --uninstall"
[ "$ENABLE_DEPLOY" = 0 ] || [ "$UNINSTALL" = 0 ] || die "--enable-deploy does not go with --uninstall"
[ -n "$ORIGIN" ] || [ -z "$HOST" ] || ORIGIN="http://$HOST"
[ -n "$CHART_REF" ] || CHART_REF="oci://$IMAGE_REGISTRY/charts/$CHART_NAME"

SECRET_NAME="$RELEASE-secrets"
PULL_SECRET_NAME="$RELEASE-registry"

if [ "$(id -u)" = 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

tty_ok() { (exec </dev/tty) 2>/dev/null; }

confirm() {
  [ "$YES" = 1 ] && return 0
  if tty_ok; then
    printf '%s [y/N] ' "$1" >/dev/tty
    read -r answer </dev/tty || answer=""
    case "$answer" in y | Y | yes | YES) return 0 ;; esac
    die "cancelled"
  fi
  die "$1 No terminal to ask on: re-run with --yes."
}

# kubectl and helm against the chosen cluster. KSUDO is set when the only
# kubeconfig is k3s's root-only one.
KSUDO=""
KUBECTL="kubectl"
kube() {
  if [ -n "$KUBECONFIG_PATH" ]; then
    # shellcheck disable=SC2086
    $KSUDO $KUBECTL --kubeconfig "$KUBECONFIG_PATH" "$@"
  else
    # shellcheck disable=SC2086
    $KUBECTL "$@"
  fi
}
hh() {
  if [ -n "$KUBECONFIG_PATH" ]; then
    $KSUDO helm --kubeconfig "$KUBECONFIG_PATH" "$@"
  else
    helm "$@"
  fi
}

pick_kubectl() {
  if has kubectl; then
    KUBECTL="kubectl"
  elif has k3s; then
    KUBECTL="k3s kubectl"
  else
    die "kubectl is not installed"
  fi
}

reachable() { kube get --raw /readyz --request-timeout=10s >/dev/null 2>&1; }

use_k3s_kubeconfig() {
  KUBECONFIG_PATH="$K3S_KUBECONFIG"
  if [ -r "$KUBECONFIG_PATH" ]; then KSUDO=""; else KSUDO="$SUDO"; fi
  pick_kubectl
}

# The channel answers with a redirect to its newest release's tag page.
resolve_k3s_version() {
  tag=$(curl -sS -o /dev/null -w '%{redirect_url}' --max-time 15 "$K3S_CHANNEL_URL" 2>/dev/null || true)
  tag=$(printf '%s' "${tag##*/}" | sed 's/%2[Bb]/+/g')
  case "$tag" in
    *[!A-Za-z0-9.+]*) ;;
    v1.[0-9]*+k3s[0-9]*)
      K3S_VERSION="$tag"
      return 0
      ;;
  esac
  warn "could not read the k3s stable channel; installing the pinned $K3S_VERSION"
}

install_k3s() {
  [ "$NO_K3S" = 0 ] || die "no cluster found and --no-k3s was given"
  [ "$(uname -s)" = Linux ] || die "no cluster found, and k3s can only be installed on Linux"
  has curl || die "curl is required"
  resolve_k3s_version
  confirm "No cluster found. Install k3s $K3S_VERSION (single node) on this host?"
  say "Installing k3s $K3S_VERSION ..."
  # The installer from the same tag as the binary, which it checksums.
  curl -sfL "https://raw.githubusercontent.com/k3s-io/k3s/$K3S_VERSION/install.sh" -o "$TMP/k3s-install.sh" \
    || die "could not download the k3s installer"
  run env INSTALL_K3S_VERSION="$K3S_VERSION" sh "$TMP/k3s-install.sh"
  [ "$DRY_RUN" = 0 ] || return 0
  use_k3s_kubeconfig
  i=0
  until [ -n "$(kube get nodes -o name 2>/dev/null)" ]; do
    i=$((i + 1))
    [ "$i" -le 60 ] || die "k3s started but no node registered"
    sleep 2
  done
  kube wait --for=condition=Ready node --all --timeout=180s >/dev/null
}

# Longhorn needs iscsid on every node, and an NFS client for its backups and
# ReadWriteMany volumes. Only this host is reachable from here, and only when
# it is the k3s node; other nodes are a documented manual step.
node_packages() {
  [ "$NODE_PACKAGES" = 1 ] || return 0
  if has iscsiadm && { has mount.nfs || [ -x /sbin/mount.nfs ] || [ -x /usr/sbin/mount.nfs ]; }; then
    start_iscsid
    return 0
  fi
  if has apt-get; then
    set -- open-iscsi nfs-common
  elif has dnf; then
    set -- iscsi-initiator-utils nfs-utils
  elif has yum; then
    set -- iscsi-initiator-utils nfs-utils
  elif has zypper; then
    set -- open-iscsi nfs-client
  elif has apk; then
    set -- open-iscsi nfs-utils
  else
    say "Longhorn needs open-iscsi and an NFS client on each node; no known package manager here, so install them yourself."
    return 0
  fi
  if [ "$YES" = 0 ] && tty_ok; then
    printf 'Install %s on this host (Longhorn needs them)? [Y/n] ' "$*" >/dev/tty
    read -r answer </dev/tty || answer=""
    case "$answer" in n | N | no | NO) say "Skipped $*; Longhorn will not start on this node without them."; return 0 ;; esac
  fi
  say "Installing $* ..."
  # shellcheck disable=SC2086
  if has apt-get; then
    run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null &&
      run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif has dnf; then
    run $SUDO dnf install -y -q "$@" >/dev/null
  elif has yum; then
    run $SUDO yum install -y -q "$@" >/dev/null
  elif has zypper; then
    run $SUDO zypper --non-interactive --quiet install "$@" >/dev/null
  else
    run $SUDO apk add --quiet "$@" >/dev/null
  fi || {
    warn "could not install $*; Longhorn will not start on this node until they are installed"
    return 0
  }
  start_iscsid
}

start_iscsid() {
  # shellcheck disable=SC2086
  if has systemctl; then
    run $SUDO systemctl enable --now iscsid >/dev/null 2>&1
  elif has rc-update; then
    run $SUDO rc-update add iscsid >/dev/null 2>&1 && run $SUDO rc-service iscsid start >/dev/null 2>&1
  fi || warn "could not start iscsid; Longhorn needs it running"
}

use_host_k3s() {
  use_k3s_kubeconfig
  reachable || die "k3s is installed but its API server does not answer (systemctl status k3s)"
  say "Using this host's k3s."
}

find_cluster() {
  if [ -n "$KUBECONFIG_PATH" ]; then
    [ -r "$KUBECONFIG_PATH" ] || die "cannot read $KUBECONFIG_PATH"
    pick_kubectl
    reachable || die "the cluster in $KUBECONFIG_PATH does not answer"
    say "Using the cluster in $KUBECONFIG_PATH."
    return 0
  fi
  # k3s's kubectl symlink falls back to k3s.yaml when nothing else is
  # configured, but helm does not, so with no kubeconfig of the caller's own
  # this host's k3s is used explicitly for both.
  if [ -z "${KUBECONFIG:-}" ] && [ ! -f "${HOME:-/nonexistent}/.kube/config" ] && [ -f "$K3S_KUBECONFIG" ]; then
    use_host_k3s
    return 0
  fi
  if has kubectl && reachable; then
    say "Using kube context $(kube config current-context 2>/dev/null || echo '(unnamed)')."
    [ "$UNINSTALL" = 1 ] || confirm "Install into this cluster?"
    return 0
  fi
  if [ -f "$K3S_KUBECONFIG" ]; then
    use_host_k3s
    return 0
  fi
  [ "$UNINSTALL" = 0 ] || die "no cluster found"
  install_k3s
}

helm_ok() {
  has helm || return 1
  # OCI charts need Helm 3.8+.
  v=$(helm version --template '{{.Version}}' 2>/dev/null || echo v0)
  case "$v" in
    v3.[0-7].* | v[0-2].*) warn "helm $v is too old for OCI charts"; return 1 ;;
  esac
}

install_helm() {
  helm_ok && return 0
  has curl || die "curl is required"
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64; sum="$HELM_SHA256_AMD64" ;;
    aarch64 | arm64) arch=arm64; sum="$HELM_SHA256_ARM64" ;;
    *) die "no pinned Helm build for $(uname -m); install Helm 3.8+ and re-run" ;;
  esac
  say "Installing Helm $HELM_VERSION ..."
  tarball="helm-$HELM_VERSION-linux-$arch.tar.gz"
  curl -sfL "https://get.helm.sh/$tarball" -o "$TMP/$tarball" || die "could not download Helm"
  if has sha256sum; then
    actual=$(sha256sum "$TMP/$tarball" | cut -d' ' -f1)
  else
    actual=$(shasum -a 256 "$TMP/$tarball" | cut -d' ' -f1)
  fi
  [ "$actual" = "$sum" ] || die "Helm checksum mismatch: expected $sum, got $actual"
  tar -xzf "$TMP/$tarball" -C "$TMP"
  # shellcheck disable=SC2086
  run $SUDO install -m 0755 "$TMP/linux-$arch/helm" /usr/local/bin/helm
}

random_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

ensure_namespace() {
  kube get namespace "$NAMESPACE" >/dev/null 2>&1 || run kube create namespace "$NAMESPACE" >/dev/null
}

# Created once. A re-run never replaces it: the data volume is sealed with
# SECRETS_KEY, and the bootstrap password only matters before first sign-in.
PASSWORD=""
ensure_secret() {
  if kube -n "$NAMESPACE" get secret "$SECRET_NAME" >/dev/null 2>&1; then
    return 0
  fi
  PASSWORD=$(head -c 18 /dev/urandom | base64 | tr '+/' 'xy')
  (
    umask 077
    printf 'SECRETS_KEY=%s\nBOOTSTRAP_ADMIN_PASSWORD=%s\n' "$(random_hex 32)" "$PASSWORD" >"$TMP/secret.env"
  )
  run kube -n "$NAMESPACE" create secret generic "$SECRET_NAME" --from-env-file="$TMP/secret.env" >/dev/null
  run kube -n "$NAMESPACE" label secret "$SECRET_NAME" "app.kubernetes.io/managed-by=$OWNER_LABEL" >/dev/null
  rm -f "$TMP/secret.env"
}

# Only while the registry is private: log Helm in for the chart and give the
# pod a pull secret for the image.
PULL_SECRET=0
registry_auth() {
  if [ -z "${REGISTRY_USER:-}" ] || [ -z "${REGISTRY_TOKEN:-}" ]; then return 0; fi
  registry_host="${IMAGE_REGISTRY%%/*}"
  case "$CHART_REF" in
    oci://*)
      if [ "$DRY_RUN" = 0 ]; then
        printf '%s' "$REGISTRY_TOKEN" | hh registry login "$registry_host" --username "$REGISTRY_USER" --password-stdin >/dev/null
      fi
      ;;
  esac
  auth=$(printf '%s:%s' "$REGISTRY_USER" "$REGISTRY_TOKEN" | base64 | tr -d '\n')
  (
    umask 077
    printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$registry_host" "$auth" >"$TMP/dockerconfig.json"
  )
  kube -n "$NAMESPACE" create secret generic "$PULL_SECRET_NAME" --type=kubernetes.io/dockerconfigjson \
    --from-file=.dockerconfigjson="$TMP/dockerconfig.json" --dry-run=client -o yaml >"$TMP/pull-secret.yaml"
  run kube -n "$NAMESPACE" apply -f "$TMP/pull-secret.yaml" >/dev/null
  rm -f "$TMP/dockerconfig.json" "$TMP/pull-secret.yaml"
  PULL_SECRET=1
}

default_ingress_class() {
  [ -z "$INGRESS_CLASS" ] || return 0
  default=$(kube get ingressclass -o jsonpath='{range .items[?(@.metadata.annotations.ingressclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
  [ -z "$default" ] || return 0
  # k3s's Traefik class is not marked default; one class is unambiguous.
  classes=$(kube get ingressclass -o name 2>/dev/null || true)
  case "$classes" in
    "") warn "no IngressClass in this cluster: the Ingress will need a controller to serve it" ;;
    *"
"*) warn "several IngressClasses and none is the default: pass --ingress-class" ;;
    *) INGRESS_CLASS="${classes#*/}" ;;
  esac
}

# Settings this run decides. On a first install they are the defaults; on an
# upgrade only what was asked for, on top of the release's previous values.
write_values() {
  first="$1"
  f="$TMP/values.yaml"
  {
    say "secrets:"
    say "  existingSecret: \"$SECRET_NAME\""
    [ -z "$IMAGE_TAG" ] || printf 'image:\n  tag: "%s"\n' "$IMAGE_TAG"
    [ "$PULL_SECRET" = 0 ] || printf 'imagePullSecrets:\n  - "%s"\n' "$PULL_SECRET_NAME"
    # Only ever turned on here; a re-run without the flag keeps what the release has.
    [ "$ENABLE_DEPLOY" = 0 ] || printf 'deploy:\n  enabled: true\n'
    if [ -n "$HOST" ]; then
      printf 'config:\n  publicOrigin: "%s"\n' "$ORIGIN"
      say "service:"
      say "  type: ClusterIP"
      say "ingress:"
      say "  enabled: true"
      [ -z "$INGRESS_CLASS" ] || say "  className: \"$INGRESS_CLASS\""
      say "  hosts:"
      say "    - host: \"$HOST\""
    else
      [ -z "$ORIGIN" ] || printf 'config:\n  publicOrigin: "%s"\n' "$ORIGIN"
      if [ "$first" = 1 ] || [ -n "$NODE_PORT" ]; then
        say "service:"
        say "  type: NodePort"
        [ -z "$NODE_PORT" ] || say "  nodePort: $NODE_PORT"
      fi
    fi
  } >"$f"
}

# A taken port fails the install here, with its owner named, rather than
# in Helm's error or by falling back to a random port. On a re-run without
# --port the port is the one the release asked for before, else the default.
check_node_port() {
  want="$NODE_PORT"
  if [ -z "$want" ] && [ "$1" = 1 ]; then
    [ "$(kube -n "$NAMESPACE" get svc "$RELEASE" -o jsonpath='{.spec.type}' 2>/dev/null || true)" = NodePort ] || return 0
    want=$(hh get values "$RELEASE" -n "$NAMESPACE" -o yaml 2>/dev/null | sed -n 's/^  nodePort: *"*\([0-9]*\)"*$/\1/p' | head -n 1)
  fi
  want="${want:-$DEFAULT_NODE_PORT}"
  owner=$(kube get svc -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {.spec.ports[*].nodePort}{"\n"}{end}' 2>/dev/null \
    | awk -v port="$want" -v self="$NAMESPACE/$RELEASE" '$1 != self { for (i = 2; i <= NF; i++) if ($i == port) print $1 }' | head -n 1)
  [ -z "$owner" ] || die "NodePort $want is already used by Service $owner; pick another with --port (30000-32767)"
}

node_ip() {
  ips=$(kube get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
  printf '%s' "${ips%% *}"
}

# How someone reads the password later, in the form that works on this host.
kubectl_hint() {
  if [ -n "$KUBECONFIG_PATH" ] && [ "$KUBECONFIG_PATH" = "$K3S_KUBECONFIG" ]; then
    if [ -n "$KSUDO" ]; then printf 'sudo k3s kubectl'; else printf 'k3s kubectl'; fi
  elif [ -n "$KUBECONFIG_PATH" ]; then
    printf 'kubectl --kubeconfig %s' "$KUBECONFIG_PATH"
  else
    printf 'kubectl'
  fi
}

do_uninstall() {
  find_cluster
  helm_ok || die "helm is not installed"
  if hh status "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1; then
    confirm "Remove release $RELEASE from namespace $NAMESPACE?"
    run hh uninstall "$RELEASE" -n "$NAMESPACE" --wait
  else
    say "No release $RELEASE in namespace $NAMESPACE."
  fi
  if [ "$PURGE" = 1 ]; then
    if kube get namespace "$NAMESPACE" >/dev/null 2>&1; then
      confirm "Delete namespace $NAMESPACE, including its data volume and Secret?"
      run kube delete namespace "$NAMESPACE" --wait=true
    fi
    say "Removed."
  else
    say "Removed the release. Kept namespace $NAMESPACE with its Secret $SECRET_NAME and data volume,"
    say "so a later install picks up where this one left off. --uninstall --purge deletes them."
  fi
}

do_install() {
  find_cluster
  [ "$KUBECONFIG_PATH" != "$K3S_KUBECONFIG" ] || node_packages
  install_helm
  if [ "$DRY_RUN" = 1 ] && ! helm_ok; then
    say "+ helm upgrade --install $RELEASE $CHART_REF --namespace $NAMESPACE ..."
    return 0
  fi

  existing=0
  hh status "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1 && existing=1
  ensure_namespace
  ensure_secret
  registry_auth
  [ -z "$HOST" ] || default_ingress_class
  [ -n "$HOST" ] || check_node_port "$existing"
  if [ "$existing" = 1 ]; then write_values 0; else write_values 1; fi

  set -- upgrade --install "$RELEASE" "$CHART_REF" --namespace "$NAMESPACE" \
    --wait --timeout "$TIMEOUT" -f "$TMP/values.yaml"
  case "$CHART_REF" in
    oci://*)
      if [ -n "$CHART_VERSION" ]; then
        set -- "$@" --version "$CHART_VERSION"
      else
        # Only edge builds are published until a release is tagged.
        set -- "$@" --devel
      fi
      ;;
  esac
  if [ "$existing" = 1 ]; then
    # --reset-then-reuse-values (Helm 3.14+) takes new chart defaults;
    # --reuse-values would pin the old ones.
    case "$(helm upgrade --help 2>/dev/null)" in
      *--reset-then-reuse-values*) set -- "$@" --reset-then-reuse-values ;;
      *) set -- "$@" --reuse-values ;;
    esac
  fi
  old_ifs="$IFS"
  IFS='
'
  set -f
  for v in $VALUES_FILES; do set -- "$@" -f "$v"; done
  set +f
  IFS="$old_ifs"

  if [ "$existing" = 1 ]; then say "Upgrading $RELEASE in $NAMESPACE ..."; else say "Installing $RELEASE into $NAMESPACE ..."; fi
  run hh "$@" >/dev/null
  [ "$DRY_RUN" = 0 ] || return 0
  kube -n "$NAMESPACE" rollout status "deploy/$RELEASE" --timeout="$TIMEOUT" >/dev/null

  url=""
  host=$(kube -n "$NAMESPACE" get ingress "$RELEASE" -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || true)
  origin=$(kube -n "$NAMESPACE" get deploy "$RELEASE" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PUBLIC_ORIGIN")].value}' 2>/dev/null || true)
  if [ -n "$origin" ]; then
    url="$origin/"
  elif [ -n "$host" ]; then
    url="http://$host/"
  else
    port=$(kube -n "$NAMESPACE" get svc "$RELEASE" -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true)
    ip=$(node_ip)
    [ -z "$port" ] || [ -z "$ip" ] || url="http://$ip:$port/"
  fi

  if [ -n "$url" ] && has curl; then
    i=0
    until curl -fsS -o /dev/null --max-time 5 "${url}healthz" 2>/dev/null; do
      i=$((i + 1))
      if [ "$i" -ge 30 ]; then
        warn "$url does not answer from this host yet (DNS or ingress may still be settling)"
        break
      fi
      sleep 2
    done
  fi

  say ""
  say "$DISPLAY_NAME is ready in namespace $NAMESPACE."
  if [ "$ENABLE_DEPLOY" = 1 ]; then
    say "App deploys are on: Jobs in $NAMESPACE run as $RELEASE-installer, which is cluster-admin."
  fi
  if [ -n "$url" ]; then
    say "URL: $url"
  else
    say "Reach it with: $(kubectl_hint) -n $NAMESPACE port-forward svc/$RELEASE 8080:80"
  fi
  if [ -n "$PASSWORD" ]; then
    say ""
    say "Sign in as admin with this password. It is shown once, and you will be asked to change it:"
    say "Password: $PASSWORD"
    say ""
    say "Until it is changed, it can be read again with:"
  else
    say "The first-sign-in password, if it has not been changed yet:"
  fi
  say "  $(kubectl_hint) -n $NAMESPACE get secret $SECRET_NAME -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d"
}

if [ "$UNINSTALL" = 1 ]; then
  do_uninstall
else
  do_install
fi
