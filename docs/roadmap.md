# Roadmap

The product started as a read-only health and backup console and has grown
into one that also sets up and runs a small cluster. The original plan split
the work into Milestone A (read-only) and Milestone B (connectors, templates,
publishing); the work has since been built in rounds, in the order people
needed it, so this page replaces that split.

Work for the next release is built on the `next` branch and merged to `main`
once it checks out on a real install ([testing-next.md](testing-next.md)).

## Principles

- **Anything the console can do itself, it does.** No redundant third-party
  tools or web UIs: when the console can drive something headless (Longhorn,
  Cloudflare, Entra), it does, and that tool's own UI isn't published.
- **Longhorn-first backups.** Velero is monitored where it already runs, but
  the console does not install it.
- **No Prometheus dependency.** Metrics come from the kubelet Summary API and
  SSH and are stored in the console's own database.
- **Connectors, not our own tunnel.** Access and identity tools (Cloudflare,
  Tailscale, Entra ID, Authentik) are managed through connectors and catalog
  apps.
- **The console's sign-in is the gate.** Cloudflare is a tunnel and DNS; apps
  the console publishes sit behind its own sign-in unless made public.
- **Nothing install-specific in the app or chart.** Hostnames, identity
  providers, ingress and registries are an install's values.
- **Read-only unless asked.** The console's own ServiceAccount only reads.
  Changes run as Jobs under a separate installer ServiceAccount, which exists
  only when deploys are turned on.

## Shipped

### Health and backup console (the first MVP)

One health board over the cluster, storage (Longhorn), backups (Longhorn,
Velero), GitOps (Fleet), SSH hosts and HTTP/TCP checks; backup posture per
PVC; node, container and host metrics with history; a read-only workload
browser with logs; notifications to ntfy, Discord and webhooks; local and
OIDC sign-in with TOTP; the setup wizard; the installer and Helm chart.

### Setup wizard and app deploys (v0.1.x)

- The app catalog, discovery of what is already installed, and the deploy
  runner (helm and kubectl Jobs under the installer ServiceAccount, off by
  default).
- The default bundle: access tool, cert-manager, Authentik, Gitea, Longhorn.
- The Access step: Cloudflare Tunnel, Tailscale, local network or direct
  ports, with a storage preflight.
- `install.sh`, `update.sh` and `add-node.sh`; join links from the console;
  one SSH key pair per install for hosts.
- The MCP server, API tokens and an OAuth server for clients such as claude.ai.
- Live usage on the workload browser; Reset to defaults; Upgrade all;
  Authentik wired as the console's sign-in.
- The `--channel next` testing channel.

### Round 3

- Raise Longhorn's replica count, and convert an app's volumes from
  local-path to Longhorn under the same claim names.
- The connector framework, with Cloudflare (tunnel, DNS, Access apps, direct
  records, tunnel adoption) and Microsoft Entra ID (the sign-in app
  registration and its secret rotation).
- Templates, a custom app from your own image, external services through
  Traefik, and a guardrail for all of them; removing an app.
- The console's sign-in in front of every app it publishes, with a per-app
  Public switch.
- Sign in with Google or Microsoft accounts through your own OAuth client.
- The Apps section (Installed, Deploy with Catalog and Templates tabs) and
  a round of fixes from running it on a fresh VM.

## Round 4 (in progress, on `next`)

| Area | What it delivers |
|---|---|
| Backups set up from the console | A **Storage target** connector (NFS export, S3/MinIO bucket, SMB/CIFS share) with a reachability check; the Backups page sets Longhorn's target, recurring snapshots and backups per volume or group, back up now and restore (to a new PVC by default); Longhorn runs headless; the console backs up its own database and offers a recovery kit for its encryption key; SMB client packages on nodes. |
| Nodes as a list | One compact row per node with state, version drift, uptime, pods and sparklines; click for the full charts; cordon, drain, uncordon and reboot (over the install's SSH key) from the page and over MCP. |
| Shared Postgres | CloudNativePG and one shared cluster as a bundle item, a database and role per app instead of chart-bundled Postgres, and point-in-time restore on the Backups page (S3/MinIO targets; nightly dumps on NFS and SMB). |
| Scoped API tokens | Tokens limited to namespaces and areas of the product, read or write, enforced the same on REST and MCP. |
| Unattended setup | `install.sh --env <file>` carries the admin password, public URL, connectors and bundle choices; the console applies them on first boot and the file is shredded. |
| Email notifications | SMTP with an app password, "sign in to send" through your own Google or Microsoft OAuth client, and Microsoft 365 through the Entra connector, with presets and a test send. |
| Entra without secret rotation | Certificate credentials the console rolls itself. |
| A lighter identity provider | Pocket ID in the catalog and as the bundle's alternative sign-in service, wired up from the Sign-in step; Authentik stays the default. |
| Move to local-path | The reverse of Convert to Longhorn, with a warning that the data then lives on one node. |
| Docs | README, docs and this roadmap kept in step with the build. |

## Later

- **Publish**: an ordered, resumable publish of any app (DNS, tunnel route,
  identity-provider access for chosen groups, a reachability check) that
  unpublish reverses exactly; today's per-app publishing covers the apps the
  console deploys.
- **Multi-cluster**: one console over several clusters.
- **Hosted sign-in broker**: Google and Microsoft sign-in with no OAuth
  client of your own.
- **Entra Private Access** as an access tool.
- **Tailscale automation** through its API.
- **A lighter host agent** for machines where SSH collection doesn't fit.
