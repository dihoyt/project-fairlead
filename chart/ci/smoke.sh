#!/usr/bin/env bash
# Installs the chart into the current kube context from a locally loaded image,
# then checks readiness, an overlapping rollout, that the ServiceAccount can
# only read, and the grants deploy.enabled adds and takes away. Usage: smoke.sh <image-repository> <image-tag>
set -euo pipefail

repo=${1:?image repository}
tag=${2:?image tag}
root=$(cd "$(dirname "$0")/../.." && pwd)
ns=$(jq -r .defaultNamespace "$root/product.json")
release=app
sa="system:serviceaccount:$ns:$release"
password=$(openssl rand -hex 16)
key=$(openssl rand -hex 32)

install() {
  helm upgrade --install "$release" "$root/chart" --namespace "$ns" --create-namespace \
    --set image.repository="$repo" --set image.tag="$tag" --set image.pullPolicy=Never \
    --set secrets.create=true \
    --set secrets.values.SECRETS_KEY="$key" \
    --set secrets.values.BOOTSTRAP_ADMIN_PASSWORD="$password" \
    --wait --timeout 4m "$@"
}

dump() {
  kubectl -n "$ns" get all,pvc,events || true
  kubectl -n "$ns" logs "deploy/$release" --tail=100 || true
}
trap 'status=$?; [ $status -eq 0 ] || dump; kill ${pf:-} 2>/dev/null || true; exit $status' EXIT

install
kubectl -n "$ns" port-forward "svc/$release" 18080:80 >/dev/null &
pf=$!
for _ in $(seq 1 20); do curl -fs localhost:18080/livez >/dev/null && break; sleep 1; done

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code localhost:18080/healthz)" = 200 ] || { echo "healthz not 200"; exit 1; }
[ "$(code localhost:18080/api/system/modules)" = 401 ] || { echo "unauthenticated /api is not refused"; exit 1; }
[ "$(code localhost:18080/)" = 200 ] || { echo "client not served"; exit 1; }
echo "ok: probes, auth refusal, client"

# A rollout overlaps old and new pod; it must complete and leave one pod.
install --set-string podAnnotations.rollout=2
kubectl -n "$ns" rollout status "deploy/$release" --timeout=4m
[ "$(kubectl -n "$ns" get pods -l "app.kubernetes.io/instance=$release" --field-selector=status.phase=Running -o name | wc -l)" = 1 ] \
  || { echo "expected exactly one running pod after rollout"; exit 1; }
echo "ok: rollout"

# Every rule on the cluster role is a read.
extra=$(kubectl get clusterrole "$ns-$release" -o json \
  | jq -r '[.rules[].verbs[]] | unique - ["get","list","watch"] | join(",")')
[ -z "$extra" ] || { echo "non-read verbs on cluster role: $extra"; exit 1; }

can() { kubectl auth can-i "$@" --as="$sa" 2>/dev/null || true; }
[ "$(can list pods --all-namespaces)" = yes ] || { echo "cannot list pods"; exit 1; }
[ "$(can get secret/k3s-join -n "$ns")" = yes ] || { echo "cannot get the k3s-join Secret"; exit 1; }
for denied in "get secret/$release-secrets -n $ns" "list secrets -n $ns"; do
  [ "$(can $denied)" = no ] || { echo "unexpectedly allowed: $denied"; exit 1; }
done
for denied in "create pods" "delete pods" "patch deployments" "get secrets --all-namespaces" "create pods/exec"; do
  [ "$(can $denied)" = no ] || { echo "unexpectedly allowed: $denied"; exit 1; }
done
kubectl auth can-i --list --as="$sa"
echo "ok: read-only"

# Deploys on: the console may start Jobs and write Secrets in its namespace
# only, the installer account is cluster-admin, and the cluster role is unchanged.
install --set deploy.enabled=true
installer="system:serviceaccount:$ns:$release-installer"
[ "$(can create jobs -n "$ns")" = yes ] || { echo "deploys on: cannot create jobs"; exit 1; }
[ "$(can create secrets -n "$ns")" = yes ] || { echo "deploys on: cannot create secrets"; exit 1; }
for denied in "get secrets -n $ns" "create jobs -n default" "create pods -n $ns" "create secrets -n default"; do
  [ "$(can $denied)" = no ] || { echo "deploys on: unexpectedly allowed: $denied"; exit 1; }
done
[ "$(kubectl auth can-i '*' '*' --as="$installer" 2>/dev/null || true)" = yes ] || { echo "installer is not cluster-admin"; exit 1; }
extra=$(kubectl get clusterrole "$ns-$release" -o json \
  | jq -r '[.rules[].verbs[]] | unique - ["get","list","watch"] | join(",")')
[ -z "$extra" ] || { echo "deploys on: non-read verbs on cluster role: $extra"; exit 1; }
kubectl -n "$ns" rollout status "deploy/$release" --timeout=4m
echo "ok: deploys on"

install --set deploy.enabled=false
[ "$(can create jobs -n "$ns")" = no ] || { echo "deploys off: still allowed to create jobs"; exit 1; }
! kubectl -n "$ns" get serviceaccount "$release-installer" >/dev/null 2>&1 || { echo "deploys off: installer remains"; exit 1; }
echo "ok: deploys off again"
