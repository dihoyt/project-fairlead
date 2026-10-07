#!/usr/bin/env bash
# Integration harness: a kind cluster loaded with a fixture set's CRD objects.
#
#   kind.sh up [SET]     create the cluster, install schemaless CRDs for every
#                        non-core group in the set, apply its namespaces and
#                        custom objects (SET defaults to "synthetic")
#   kind.sh crds [SET]   print the CRDs as JSON without touching a cluster
#   kind.sh down         delete the cluster
#   kind.sh env          print "export KUBECONFIG=..." for the cluster
#
# Core objects (nodes, pods, events) are not applied: their status belongs to
# controllers, so the real kind cluster supplies its own and tests that need
# the synthetic ones use the fake API. Objects are applied with server-set
# fields removed; the CRDs have no status subresource so status is kept.
# Cluster name and kubeconfig path are overridable: KIND_CLUSTER, KIND_KUBECONFIG.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$HERE/../../fixtures"
CLUSTER="${KIND_CLUSTER:-integration}"
KUBECONFIG_FILE="${KIND_KUBECONFIG:-${TMPDIR:-/tmp}/kind-$CLUSTER.kubeconfig}"
CORE_DIRS="core apps batch storage.k8s.io metrics.k8s.io kubelet logs"

set_dir() {
  local dir="$FIXTURES/${1:-synthetic}"
  [ -d "$dir" ] || { echo "No fixture set at $dir" >&2; exit 1; }
  echo "$dir"
}

custom_files() {
  local dir="$1" group file
  for group in "$dir"/*/; do
    group="$(basename "$group")"
    case " $CORE_DIRS " in *" $group "*) continue ;; esac
    for file in "$dir/$group"/*.json; do [ -f "$file" ] && echo "$file"; done
  done
}

crds() {
  local file
  while IFS= read -r file; do
    jq -c --arg plural "$(basename "$file" .json)" --arg group "$(basename "$(dirname "$file")")" '
      select((.items | length) > 0) | .items[0] as $first
      | {
          apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition",
          metadata: { name: "\($plural).\($group)" },
          spec: {
            group: $group,
            scope: (if $first.metadata.namespace then "Namespaced" else "Cluster" end),
            names: { plural: $plural, singular: ($first.kind | ascii_downcase), kind: $first.kind, listKind: "\($first.kind)List" },
            versions: [{
              name: ($first.apiVersion | split("/")[1]), served: true, storage: true,
              schema: { openAPIV3Schema: { type: "object", "x-kubernetes-preserve-unknown-fields": true } }
            }]
          }
        }' "$file"
  done < <(custom_files "$1")
}

case "${1:-}" in
  crds) crds "$(set_dir "${2:-}")" | jq -s '{apiVersion: "v1", kind: "List", items: .}' ;;
  up)
    for tool in kind kubectl jq; do command -v "$tool" >/dev/null || { echo "Needs $tool on PATH." >&2; exit 1; }; done
    dir="$(set_dir "${2:-}")"
    kind get clusters | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG_FILE" --wait 120s
    kind export kubeconfig --name "$CLUSTER" --kubeconfig "$KUBECONFIG_FILE"
    export KUBECONFIG="$KUBECONFIG_FILE"
    crds "$dir" | jq -s '{apiVersion: "v1", kind: "List", items: .}' | kubectl apply -f -
    kubectl wait --for=condition=Established crd --all --timeout=60s
    jq '.items[] | {apiVersion, kind, metadata: {name: .metadata.name, labels: .metadata.labels}}' "$dir/core/namespaces.json" | kubectl apply -f -
    while IFS= read -r file; do
      jq '{apiVersion: "v1", kind: "List", items: [.items[] | del(.metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp, .metadata.generation, .metadata.finalizers, .metadata.ownerReferences, .metadata.selfLink)]}' "$file" | kubectl apply -f -
    done < <(custom_files "$dir")
    echo "export KUBECONFIG=$KUBECONFIG_FILE"
    ;;
  down) kind delete cluster --name "$CLUSTER" ;;
  env) echo "export KUBECONFIG=$KUBECONFIG_FILE" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
