# project-fairlead

A self-hosted Kubernetes console that answers one question first: **is everything healthy and recoverable?** It then helps you set up and run the cluster so that the answer stays yes, without a stack of other tools to learn.

The product's working name is Fairlead; the name the code uses lives only in `product.json`.

## What it does

**See**

- **One health board** over the cluster, storage, backups, GitOps, hosts, HTTP checks and connectors, with a history strip per check and the raw data behind every failure.
- **Backup posture** for every PVC: which backup covers it (Longhorn, Velero), when it last succeeded, whether that is on schedule, how full the target is, and when a restore was last proven.
- **Metrics with history** for nodes, containers and SSH hosts (NAS, Linux boxes), stored in its own database: no Prometheus needed.
- **A workload browser**: namespaces, workloads, pods, events and logs, with live usage, secrets redacted, and links into Rancher or Headlamp.
- **Notifications** to ntfy, Discord or any webhook when a check changes.

**Set up and run** (with app deploys turned on)

- **A default bundle** for a first self-hosted cluster: an access tool (Cloudflare Tunnel, Tailscale, local network or direct ports), cert-manager, Authentik (or the lighter, passkey-only Pocket ID) for sign-in, Gitea for git, and Longhorn for replicated storage, each with sensible requests and limits.
- **A catalog and Templates**: more apps (Headlamp, Grafana, ntfy, Rancher, Velero, ...), small app templates, your own container image as a custom app, and external services published through Traefik. A guardrail refuses host paths, privileged containers, host networking and RBAC in templates.
- **Connectors** that manage other services for you: Cloudflare (tunnel, DNS records, optional Access apps, direct records with your public IP) and Microsoft Entra ID (the sign-in app registration and its secret).
- **The console's sign-in in front of every app** it publishes, through a Traefik forward-auth gate, with a per-app Public switch.
- **Storage actions**: raise Longhorn's replica count, and move an app's volumes from local-path to Longhorn under the same claim names, with a download of the data first.
- **Nodes**: a one-time join link (or `add-node.sh` over SSH) adds a machine to a k3s cluster.
- **Upgrade all**: every app the console installed, upgraded in dependency order, keeping its values.
- **An MCP server and API tokens**, so an assistant such as Claude can read the board and make the same changes you can, through the same permissions and audit log.

Everything runs as one pod with SQLite on a small volume. The console's own ServiceAccount is read-only. Deploys are off until you turn them on (`install.sh --enable-deploy`); then each change runs as a Kubernetes Job under a separate installer ServiceAccount, so the console's pod never holds cluster-admin itself. See [docs/install.md](docs/install.md#deploying-apps-from-the-console) for the trade-off.

## Principles

- Anything the console can do itself, it does: no redundant third-party tools or web UIs to install, learn and secure.
- Backups are Longhorn-first. Velero is monitored where it already runs, but not installed.
- No Prometheus dependency: metrics come from the kubelet and SSH, and live in the console's own database.
- Access and identity tools are managed through connectors. There is no tunnel of our own.
- Cloudflare is a tunnel and DNS; the console's sign-in is the gate in front of your apps.
- Nothing install-specific lives in the app or the chart: hostnames, identity providers, ingress and registries are an install's values.

Where this is heading is in [docs/roadmap.md](docs/roadmap.md).

## Quickstart (about a minute)

On a Linux host with a cluster (or with nothing, and the installer brings up a single-node k3s):

```
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/install.sh | sh -
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/install.sh | sh -s -- --enable-deploy
```

It installs Helm if needed, generates the encryption key and the first admin password into a Secret, installs the chart, waits for the pod and prints the URL and the password. Without `--host` the console is on NodePort 32450 of every node; `--host console.example.com` serves it through an Ingress instead. Re-running upgrades in place; `update.sh` does the same with the release's current settings. Every flag is in [scripts/install/README.md](scripts/install/README.md).

Sign in as `admin` with the printed password, choose a new one, and the setup wizard takes you through the rest: public URL, cluster permissions, how you reach your apps, sign-in, links to your other tools, a first host, a first HTTP check and a notification channel. Every step can be skipped and reopened later under **Setup**.

To try the build that will become the next release, add `--channel next`; see [docs/testing-next.md](docs/testing-next.md).

## Documentation

| | |
|---|---|
| [docs/install.md](docs/install.md) | The installer and `update.sh`, Helm by hand, values, cluster access, app deploys, adding nodes |
| [docs/configuration.md](docs/configuration.md) | Environment variables, settings, and the Kubernetes permissions each feature needs |
| [docs/modules.md](docs/modules.md) | What each part watches or does, and where it shows up |
| [docs/mcp.md](docs/mcp.md) | The MCP server, API tokens and connecting an assistant |
| [docs/roadmap.md](docs/roadmap.md) | What has shipped, what is being built, and what comes later |
| [docs/testing-next.md](docs/testing-next.md) | Installing and rolling back a build from the `next` branch |

## Development

```
npm ci && npm --prefix client ci
npm run dev                 # server on :8080, signed in as a built-in admin
npm --prefix client run dev # UI on :5173, proxying the API
npm run check               # lint, format, typecheck, tests, brand check
```

`CLAUDE.md` describes how the repository is organised and the rules every change follows; `CONTRIBUTING.md` covers contributions.

Licensed under the MIT License (see `LICENSE`).
