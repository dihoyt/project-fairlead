#!/usr/bin/env bash
# Captures real object shapes from a cluster as test fixtures.
#
# Read-only: it runs nothing but `kubectl get` (including `get --raw`).
# Never captured: Secrets, ConfigMaps. Stripped from what is captured: env
# values, container command/args, annotations other than the ownership ones
# the product reads (Fleet, Argo, Helm, Longhorn, Velero, cert-manager),
# managedFields, Fleet bundle resources and Helm values, and credentials
# embedded in http(s)/git/ssh URLs. Hostnames, IPs and object names remain:
# review the archive before it goes anywhere public.
#
# Usage: capture-fixtures.sh [--context NAME] [--out DIR] [--kubelet-nodes N]
set -euo pipefail

CONTEXT=""
OUT="fixtures-$(date -u +%Y%m%dT%H%M%SZ)"
KUBELET_NODES=2

while [ $# -gt 0 ]; do
  case "$1" in
    --context) CONTEXT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --kubelet-nodes) KUBELET_NODES="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

for tool in kubectl jq tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Needs $tool on PATH." >&2; exit 1; }
done

kc() {
  if [ -n "$CONTEXT" ]; then kubectl --context "$CONTEXT" "$@"; else kubectl "$@"; fi
}

# Applied to every captured document.
read -r -d '' STRIP <<'JQ' || true
def keep_annotation: test("^(objectset\\.rio\\.cattle\\.io/|fleet\\.cattle\\.io/|argocd\\.argoproj\\.io/|meta\\.helm\\.sh/|longhorn\\.io/|velero\\.io/|cert-manager\\.io/)");
def scrub_url: if type == "string" then gsub("(?<s>(https?|git|ssh)://)[^/@\\s]+@"; "\(.s)REDACTED@") else . end;
def scrub_env: if type == "array" then map(if has("value") then .value = "REDACTED" else . end) else . end;
def scrub_meta:
  if type == "object" and has("metadata") and (.metadata | type) == "object" then
    .metadata |= (del(.managedFields)
      | if has("annotations") and (.annotations | type) == "object"
        # A kept annotation can still embed a whole manifest (Rancher's
        # objectset.rio.cattle.io/applied is gzip+base64 of the applied object,
        # env values included), so serialized values are dropped too.
        then .annotations |= with_entries(select(.key | keep_annotation)
          | if (.key | test("/(applied|client-secret-hash)$")) or ((.value | tostring) | test("^(H4sI|\\{|\\[)"))
            then .value = "REDACTED" else . end)
        else . end)
  else . end;
walk(
  if type == "object" then
    scrub_meta
    | (if has("env") then .env |= scrub_env else . end)
    | (if has("command") and (.command | type) == "array" then .command = ["REDACTED"] else . end)
    | (if has("args") and (.args | type) == "array" then .args = ["REDACTED"] else . end)
  else scrub_url end
)
# kubectl wraps every kind in a generic List, so match on the items' own kind.
| if (.items | type) == "array" then .items |= map(
    if .kind == "Bundle" then
      (if .spec.resources then .spec.resources |= map({name}) else . end)
      | (if .spec.helm.values then .spec.helm.values = {} else . end)
    elif .kind == "Node" then del(.status.images)
    else . end)
  else . end
JQ

mkdir -p "$OUT"
: > "$OUT/absent.txt"

capture() {
  # $1: resource (plural[.group]), $2: output file, $3: "cluster" for cluster-scoped
  local resource="$1" file="$OUT/$2" scope="${3:-}"
  local args=(get "$resource" -o json)
  [ "$scope" = "cluster" ] || args+=(--all-namespaces)
  mkdir -p "$(dirname "$file")"
  local raw
  if raw="$(kc "${args[@]}" 2>"$file.err")"; then
    printf '%s' "$raw" | jq "$STRIP" > "$file"
    rm -f "$file.err"
    printf '  %-48s %s\n' "$resource" "$(jq '.items | length' "$file") objects"
  else
    echo "$resource: $(tr '\n' ' ' < "$file.err")" >> "$OUT/absent.txt"
    rm -f "$file.err"
    printf '  %-48s %s\n' "$resource" "not available (see absent.txt)"
  fi
}

raw() {
  # $1: API path, $2: output file
  local file="$OUT/$2"
  mkdir -p "$(dirname "$file")"
  local body
  if body="$(kc get --raw "$1" 2>/dev/null)"; then
    printf '%s' "$body" | jq "$STRIP" > "$file"
    printf '  %-48s %s\n' "$1" "saved"
  else
    echo "$1: not available" >> "$OUT/absent.txt"
    printf '  %-48s %s\n' "$1" "not available (see absent.txt)"
  fi
}

echo "Capturing from context: $(kc config current-context)"
raw /version core/version.json
raw /apis core/apis.json

capture namespaces core/namespaces.json cluster
capture nodes core/nodes.json cluster
capture pods core/pods.json
capture events core/events.json
capture persistentvolumeclaims core/persistentvolumeclaims.json
capture persistentvolumes core/persistentvolumes.json cluster
capture storageclasses.storage.k8s.io storage.k8s.io/storageclasses.json cluster
for kind in deployments statefulsets daemonsets replicasets; do
  capture "$kind.apps" "apps/$kind.json"
done
capture jobs.batch batch/jobs.json
capture cronjobs.batch batch/cronjobs.json

for kind in volumes nodes replicas snapshots backups backupvolumes backuptargets recurringjobs settings; do
  capture "$kind.longhorn.io" "longhorn.io/$kind.json"
done
for kind in backups schedules restores backupstoragelocations; do
  capture "$kind.velero.io" "velero.io/$kind.json"
done
capture gitrepos.fleet.cattle.io fleet.cattle.io/gitrepos.json
capture bundles.fleet.cattle.io fleet.cattle.io/bundles.json
capture certificates.cert-manager.io cert-manager.io/certificates.json

raw /apis/metrics.k8s.io/v1beta1/nodes metrics.k8s.io/nodes.json
raw /apis/metrics.k8s.io/v1beta1/pods metrics.k8s.io/pods.json

if [ "$KUBELET_NODES" -gt 0 ]; then
  for node in $(kc get nodes -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n' | head -n "$KUBELET_NODES"); do
    raw "/api/v1/nodes/$node/proxy/stats/summary" "kubelet/summary-$node.json"
  done
fi

tar -czf "$OUT.tar.gz" "$OUT"
echo
echo "Wrote $OUT.tar.gz ($(du -h "$OUT.tar.gz" | cut -f1)). Review it, then upload it to the project."
