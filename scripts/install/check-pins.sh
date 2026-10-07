#!/usr/bin/env bash
# Checks the versions and checksums pinned in install.sh against what their
# publishers serve, so a typo or a re-tagged release fails CI rather than an
# install.
set -euo pipefail

installer=${1:-install.sh}
pin() { sed -n "s/^$1=\"\(.*\)\"$/\1/p" "$installer"; }

helm_version=$(pin HELM_VERSION)
k3s_version=$(pin K3S_VERSION)
status=0
for arch in amd64 arm64; do
  var="HELM_SHA256_$(echo "$arch" | tr '[:lower:]' '[:upper:]')"
  pinned=$(pin "$var")
  published=$(curl -fsSL "https://get.helm.sh/helm-$helm_version-linux-$arch.tar.gz.sha256sum" | cut -d' ' -f1)
  if [ "$pinned" = "$published" ]; then
    echo "ok: $var"
  else
    echo "$var is $pinned; get.helm.sh publishes $published"
    status=1
  fi
done
if curl -fsSL -o /dev/null "https://raw.githubusercontent.com/k3s-io/k3s/$k3s_version/install.sh"; then
  echo "ok: k3s $k3s_version"
else
  echo "k3s $k3s_version has no installer at that tag"
  status=1
fi
exit "$status"
