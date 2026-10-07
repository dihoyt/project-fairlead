# project-fairlead

A self-hosted Kubernetes console that answers one question first: **is everything healthy and recoverable?**

- **One health board** over the cluster, storage, backups, GitOps, hosts and HTTP checks, with a history strip per check and the raw data behind every failure.
- **Backup posture** for every PVC: which backup covers it (Longhorn, Velero), when it last succeeded, whether that is on schedule, how full the target is, and when a restore was last proven.
- **Metrics with history** for nodes, containers and SSH hosts (NAS, Linux boxes), stored in its own database: no Prometheus needed.
- **A read-only workload browser**: namespaces, workloads, pods, events and logs, with secrets redacted and links into Rancher or Headlamp.
- **Notifications** to ntfy, Discord or any webhook when a check changes.

It reads the cluster through a read-only ClusterRole and never writes to it. Everything runs as one pod with SQLite on a small volume.

The product's working name is Fairlead; the name the code uses lives only in `product.json`.

## Quickstart (about a minute)

On a Linux host with a cluster (or with nothing, and the installer brings up a single-node k3s):

```
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/install.sh | sh -
```

It installs Helm if needed, generates the encryption key and the first admin password into a Secret, installs the chart, waits for the pod and prints the URL and the password. Add `--host console.example.test` to serve it through an Ingress instead of a NodePort. Re-running upgrades in place.

While the repository and its packages are private the one-liner does not work yet; [scripts/install/README.md](scripts/install/README.md) shows how to fetch it with a token, and lists every flag.

Sign in as `admin` with the printed password, choose a new one, and the setup wizard takes you through the rest: cluster permissions, single sign-on, links to your other tools, a first host, a first HTTP check and a notification channel. Every step can be skipped and reopened later under **Setup**.

## Documentation

| | |
|---|---|
| [docs/install.md](docs/install.md) | The installer, Helm by hand, values, cluster access, deploying from a Gitea mirror |
| [docs/configuration.md](docs/configuration.md) | Environment variables, settings, and the Kubernetes permissions each feature needs |
| [docs/modules.md](docs/modules.md) | What each part watches and where it shows up |
| [docs/dogfood.md](docs/dogfood.md) | Runbook for the first real install on the maintainer's cluster |

## Development

```
npm ci && npm --prefix client ci
npm run dev                 # server on :8080, signed in as a built-in admin
npm --prefix client run dev # UI on :5173, proxying the API
npm run check               # lint, format, typecheck, tests, brand check
```

`CLAUDE.md` describes how the repository is organised and the rules every change follows; `CONTRIBUTING.md` covers contributions.

Licensed under the MIT License (see `LICENSE`).
