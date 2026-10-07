#!/usr/bin/env bash
# Blocks until an image tag exists on ghcr.io, so a deploy never runs ahead of
# the publish workflow. Usage: wait-for-image.sh <owner/image> <tag>
# Env: GHCR_USER and GHCR_TOKEN (a token with read:packages) when the package
# is private; both may be empty for a public one. WAIT_SECONDS defaults to 1200.
set -euo pipefail

image=${1:?owner/image}
tag=${2:?tag}
deadline=$((SECONDS + ${WAIT_SECONDS:-1200}))
auth=()
[ -n "${GHCR_TOKEN:-}" ] && auth=(-u "${GHCR_USER:?GHCR_USER}:${GHCR_TOKEN}")

while :; do
  bearer=$(curl -fsS "${auth[@]}" "https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull" | jq -r .token)
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${bearer}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/${image}/manifests/${tag}")
  [ "$code" = 200 ] && exit 0
  [ "$SECONDS" -lt "$deadline" ] || { echo "image ${image}:${tag} not found (last status ${code})" >&2; exit 1; }
  sleep 20
done
