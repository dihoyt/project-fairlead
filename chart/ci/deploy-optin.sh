#!/usr/bin/env bash
# Renders the chart with deploys off and on: off adds nothing, on adds only
# the installer account and the namespaced Job/Secret grant, and the
# read-only ClusterRole is identical either way. Needs helm and yq (v4).
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
off=$(helm template r "$root/chart" --namespace ns)
on=$(helm template r "$root/chart" --namespace ns --set deploy.enabled=true)
fail() { echo "deploy opt-in: $*"; exit 1; }
q() { yq -r -o json -I0 "select(.kind) | $2" <<<"$1" | sed "/^$/d"; }

clusterrole='select(.kind == "ClusterRole") | .rules'
[ "$(q "$off" "$clusterrole")" = "$(q "$on" "$clusterrole")" ] || fail "the ClusterRole changes with deploys on"
[ "$(q "$on" "$clusterrole | [.[].verbs[]] | unique | join(\",\")")" = "get,list,watch" ] \
  || fail "the ClusterRole has non-read verbs"

kinds='.kind + "/" + .metadata.name'
added=$(comm -13 <(q "$off" "$kinds" | sort) <(q "$on" "$kinds" | sort) | tr '\n' ' ')
[ "$added" = "ClusterRoleBinding/ns-r-installer Role/r-deploy RoleBinding/r-deploy ServiceAccount/r-installer " ] \
  || fail "deploys on adds unexpected objects: $added"
[ -z "$(comm -23 <(q "$off" "$kinds" | sort) <(q "$on" "$kinds" | sort))" ] || fail "deploys on removes objects"

binding=$(q "$on" 'select(.kind == "ClusterRoleBinding" and .metadata.name == "ns-r-installer") | [.roleRef.name, .subjects[0].name, .subjects[0].namespace] | join(",")')
[ "$binding" = "cluster-admin,r-installer,ns" ] || fail "installer binding is $binding"

rules=$(q "$on" 'select(.kind == "Role" and .metadata.name == "r-deploy") | .rules[] | (.apiGroups[0] + "/" + (.resources | join(",")) + ":" + (.verbs | join(",")))' | tr '\n' ' ')
[ "$rules" = "batch/jobs:create,get,list,watch,delete /secrets:create,delete " ] || fail "deploy Role rules are $rules"
subject=$(q "$on" 'select(.kind == "RoleBinding" and .metadata.name == "r-deploy") | .subjects[0].name')
[ "$subject" = r ] || fail "deploy RoleBinding binds $subject, not the console's account"

pod='select(.kind == "Deployment") | .spec.template.spec'
[ "$(q "$on" "$pod | .serviceAccountName")" = r ] || fail "the console pod does not run as its own account"
env() { q "$1" "$pod | .containers[0].env[] | select(.name | test(\"^DEPLOY_\")) | .name" | tr '\n' ' '; }
[ "$(env "$off")" = "DEPLOY_RELEASE DEPLOY_CHART " ] || fail "deploys off sets $(env "$off")"
[ "$(env "$on")" = "DEPLOY_RELEASE DEPLOY_CHART DEPLOY_INSTALLER_SERVICE_ACCOUNT DEPLOY_IMAGE " ] \
  || fail "deploys on sets $(env "$on")"
q "$on" "$pod | .containers[0].env[] | select(.name == \"DEPLOY_IMAGE\") | .value" | grep -q '@sha256:[0-9a-f]\{64\}$' \
  || fail "deploy.image is not pinned by digest"

echo "ok: deploy opt-in renders"
