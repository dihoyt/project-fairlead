# Installer

`install.sh` at the repository root installs or upgrades the console on a Linux
host in one command. It uses the cluster it finds (`--kubeconfig`, else the
current kube context, else this host's k3s; with no `KUBECONFIG` and no
`~/.kube/config`, this host's k3s comes first) and installs a pinned single-node
k3s only when there is none, asking first unless `--yes` is given. It installs a
pinned, checksum-verified Helm when Helm is missing.

## Fetching it

While the repository is private, fetch it through the GitHub API with a token
that can read the repository:

```
gh api -H 'Accept: application/vnd.github.raw' repos/dihoyt/project-fairlead/contents/install.sh > install.sh
REGISTRY_USER=<github user> REGISTRY_TOKEN=<token with read:packages> sh install.sh
```

`REGISTRY_USER` / `REGISTRY_TOKEN` are only needed while the ghcr packages are
private: the installer logs Helm in for the chart and creates a pull secret for
the image.

Once the repository and packages are public:

```
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/install.sh | sh -
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/install.sh | sh -s -- --host console.example.test
```

## What it does

1. Finds or installs the cluster, and installs Helm if needed.
2. Creates the namespace and a Secret `<release>-secrets` holding a generated
   `SECRETS_KEY` and `BOOTSTRAP_ADMIN_PASSWORD`. Only on the first install: a
   re-run never replaces it, since the database is sealed with that key.
3. `helm upgrade --install` of the chart from ghcr (newest published version,
   edge builds included, unless `--version`). Without `--host` the Service is a
   NodePort; with it, an Ingress on the cluster's default class (or the only
   one, such as k3s's Traefik) and `config.publicOrigin` of `http://<host>`
   (`--origin` overrides). Storage is the cluster's default class.
4. Waits for the rollout, prints the URL and, on the first install only, the
   admin password with the command to read it again.

A re-run upgrades in place, keeping the release's earlier values
(`--reset-then-reuse-values`) and applying only the flags given. `--values`
files are applied last, so they override everything the installer sets.

`--uninstall` removes the release and keeps the namespace, its Secret and the
data volume, so a later install picks up the same data. `--uninstall --purge`
deletes the namespace too. Neither touches k3s; remove that with
`/usr/local/bin/k3s-uninstall.sh`.

Run `install.sh --help` for every flag.

## Pins

`K3S_VERSION`, `HELM_VERSION` and the Helm checksums are at the top of
`install.sh`. `check-pins.sh` compares them with what k3s and get.helm.sh
publish, and runs in CI with `assert-install.sh`
(`.github/workflows/install-test.yml`).
