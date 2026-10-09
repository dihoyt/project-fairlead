# Installing

The chart is `chart/` in this repository. It deploys one pod (SQLite on a
ReadWriteOnce volume), a Service, an optional Ingress and NetworkPolicy, and a
read-only ClusterRole. With app deploys turned on it adds an installer
ServiceAccount that the console's Jobs run as (see "Deploying apps from the
console"). Nothing in the defaults is specific to an install.

There are three ways in, from quickest to most controlled:

1. **The installer** (`install.sh`): one command on a Linux host. Below.
2. **Helm by hand**: a Secret and `helm upgrade --install`. Under "Install with Helm".
3. **GitOps from a Gitea pull mirror**: what a homelab that already deploys
   from Gitea uses. Under "Deploying from a Gitea pull mirror".

All three end at the same place: sign in as `admin` with the bootstrap
password, change it, and the setup wizard opens (see "After installing").

## Installer

```
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/install.sh | sh -
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/install.sh | sh -s -- --host console.example.test
```

It uses the cluster it finds (`--kubeconfig`, else the current context, else
this host's k3s) and installs a single-node k3s only when there is none,
asking first unless `--yes`. That k3s is the newest release on the k3s stable
channel, read at install time, or the version pinned in the script when the
channel can't be reached. A re-run never upgrades a k3s that is already
there: an older one (some current charts, such as Longhorn 1.13, need
Kubernetes 1.34 or newer) is upgraded with k3s's own tooling, for example
`curl -sfL https://get.k3s.io | INSTALL_K3S_CHANNEL=stable sh -`. It generates `SECRETS_KEY` and
`BOOTSTRAP_ADMIN_PASSWORD` into `<release>-secrets` on the first install only,
installs the chart from ghcr, waits for the rollout and prints the URL and the
password. Without `--host` the console is served on NodePort 32450 of every
node (`http://<node IP>:32450/`); `--port <n>` picks another in 30000-32767. If
the port is already taken by another Service the install stops and names it,
rather than falling back to a random port. A re-run moves an install that got a
random port earlier onto 32450 (or `--port`). Re-running upgrades in place and keeps earlier values; `--values`
files are applied last. `--uninstall` keeps the namespace, Secret and volume.
`--enable-deploy` turns on app deploys (see "Deploying apps from the console");
they stay off unless it is given, and a later re-run without it leaves them as
they are.

When the cluster is this host's k3s, the installer also installs Longhorn's
node prerequisites, `open-iscsi` (with `iscsid` enabled and started) and the
NFS client (`nfs-common` / `nfs-utils` / `nfs-client`), through apt, dnf, yum,
zypper or apk. They are small (a few MB) and are skipped when already there,
when no known package manager is found, or with `--no-node-packages`. The
installer cannot reach other nodes: on a multi-node cluster, run the same on
each agent node before deploying Longhorn, for example on Debian or Ubuntu

```
sudo apt-get install -y open-iscsi nfs-common && sudo systemctl enable --now iscsid
```

or on Fedora, RHEL and their relatives

```
sudo dnf install -y iscsi-initiator-utils nfs-utils && sudo systemctl enable --now iscsid
```

Every flag is in [scripts/install/README.md](../scripts/install/README.md).
Installing from a private fork or mirror takes `REGISTRY_USER` /
`REGISTRY_TOKEN`, described there too.

## Unattended setup from an env file

`install.sh --env <file>` sets the console up on its first boot from a file of
`KEY=value` lines, so a fresh install comes up with its admin password, public
URL, connectors, email channel and app bundle already in place. Without
`--env`, the installer uses `/etc/<slug>/install.env` (the product's slug, as in
the namespace) when that file exists.

```
sudo install -m 600 /dev/stdin /root/install.env <<'ENV'
ADMIN_PASSWORD=a-long-password-you-chose
PUBLIC_URL=https://console.example.com
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ZONE=example.com
STORAGE_URL=cifs://nas.example.com/backups
STORAGE_USER=backup
STORAGE_SECRET=...
SMTP_PRESET=gmail
SMTP_USER=alerts@example.com
SMTP_PASSWORD=...
SMTP_FROM=alerts@example.com
SMTP_TO=you@example.com
BUNDLE=default
ADMIN_EMAIL=you@example.com
ENV
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/install.sh | sudo sh -s -- --env /root/install.env --enable-deploy
```

Before changing anything, the installer checks every line: blank lines,
`# comments`, `export KEY=value` and quoted values are fine; an unknown key, a
key set twice or a line that isn't `KEY=value` stops it with the line number
and the key, never the value. It stores the values in the Secret
`install-seed` in the console's namespace, which the console can read and
delete and nothing else, and once the install has succeeded it overwrites and
deletes the file (`shred -u`, or zeros then `rm` where `shred` is missing).
`--keep-env` keeps it. Empty values are left out. `--env` is for a first
install: on a cluster where the console is already installed, it stops
(unless the earlier `--env` install never finished, in which case it tries
again). `update.sh` doesn't take it.

On its first boot the console reads the Secret, keeps the values sealed with
`SECRETS_KEY`, sets the admin password, the public URL and OIDC sign-in, and
deletes the Secret. The rest is applied as the first admin who signs in, through
the same checks and audit log as the forms; the welcome page does it on its
own and shows a "Set up from your file" summary with each item's result and,
for a failure, the reason. With `ADMIN_PASSWORD` set, that password signs in
and is not asked to be changed (an authenticator, if required, still is); the
installer prints no generated password.

| Keys | Sets up |
|---|---|
| `ADMIN_PASSWORD` | The `admin` account's password, at least 10 characters. |
| `PUBLIC_URL` | The public URL (Admin > Settings), e.g. `https://console.example.com`. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCESS_APPS` | The Cloudflare connector, its tunnel and cloudflared. The account ID can be left out when the token sees one account. `CLOUDFLARE_ACCESS_APPS`: `never` (default), `always` or `per-app`. |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_ADMIN_GROUPS` | The Entra ID connector (the management app), then sign-in through the app registration it creates. Admin groups are object ids, comma separated. Needs an `https` public URL. |
| `STORAGE_URL`, `STORAGE_PATH`, `STORAGE_ENDPOINT`, `STORAGE_USER`, `STORAGE_SECRET` | A backup storage target. The scheme picks the protocol: `nfs://server:/export`, `s3://bucket@region/` (with `STORAGE_ENDPOINT` for MinIO) or `cifs://server/share`. User and secret are the S3 access key pair or the SMB username and password. |
| `SMTP_PRESET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_TO` | An email notification channel. Presets: `gmail`, `yahoo`, `icloud`, `fastmail`, `sendgrid`, `mailgun`, `ses`, `smtp` (any server: give host and port), or `entra` (Microsoft 365 through the Entra connector, no password). The sign-in-to-send presets need a person at a browser, so they aren't offered here. `SMTP_TO`: comma separated. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_LABEL`, `OIDC_ADMIN_GROUPS` | Sign-in through any OIDC provider, as in Admin > Sign-in. |
| `BUNDLE`, `BUNDLE_ACCESS`, `BASE_DOMAIN`, `ADMIN_EMAIL`, `STORAGE_CLASS`, `AUTHENTIK_BOOTSTRAP_PASSWORD` | The Deploy bundle (needs `--enable-deploy`). `BUNDLE=default` takes the bundle's own ticks; a comma-separated list of optional apps (`longhorn`) ticks those instead. `BUNDLE_ACCESS`: `cloudflare-tunnel` (through the connector above; the default when a Cloudflare token is given), `local` (otherwise the default) or `direct`. `BASE_DOMAIN` defaults to `CLOUDFLARE_ZONE`. `ADMIN_EMAIL` is required. `AUTHENTIK_BOOTSTRAP_PASSWORD` is the apps' first admin password, `ADMIN_PASSWORD` when left out. |

## Restoring the console

What a lost console needs back is its database and the `SECRETS_KEY` that
opens the secrets stored in it. Backups → This console keeps both: a nightly
copy of the database on the storage target, and **Download recovery kit**,
`SECRETS_KEY` sealed with a passphrase you choose. Keep the kit and its
passphrase away from the cluster.

On a fresh host or cluster, fetch the newest copy from the target
(`<prefix>console/<release>-<UTC time>.db` on the NFS export or in the
bucket), then:

```sh
sudo ./install.sh --restore ./recovery-kit.txt --from ./<release>-<UTC time>.db
```

It asks for the passphrase (or reads `KIT_PASSPHRASE`), takes the release
name and namespace from the kit unless `--release` or `--namespace` say
otherwise, stores the kit's key in the release's Secret, installs as usual,
then stops the console, puts the copy in place of its database and starts it
again. Sign in with an account from the copy; connectors, sign-in and
notifications come back as they were. `--restore` without `--from` installs
with the kit's key and an empty database, for a volume that survived. It
refuses an existing release (`install.sh --uninstall` first) and a Secret
holding another key.

## Updating

`update.sh` upgrades an existing install in place to the newest published
chart (or `--version`), and stops with a pointer to `install.sh` when there is
no release to update. It keeps the release's settings, including the NodePort,
host, origin and app deploys, unless a flag such as `--port`, `--host`,
`--origin` or `--enable-deploy` changes them. It prints the chart and image
before and after, and waits for the rollout.

```
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/update.sh | sh -
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/update.sh | sh -s -- --k3s --prereqs
```

Two extras, both off unless asked for, and both only for this host's k3s:

- `--k3s` upgrades k3s to the stable channel's newest release (`install.sh`
  never upgrades k3s). It swaps the checksum-verified binary and restarts the
  `k3s` or `k3s-agent` service, so the flags k3s was installed with are kept.
  Other nodes are not touched: run it on each, servers first.
- `--prereqs` installs open-iscsi and the NFS client on this host (see
  "Installer").

`update.sh` is `install.sh` with one line changed, and takes the same flags
(`update.sh --help`). `scripts/install/gen-scripts.sh` regenerates it, and CI
fails if it falls out of step.

## Adding nodes over SSH

`add-node.sh` joins more machines to a k3s cluster from one of its server
nodes. For each `user@host` it logs in over SSH, installs open-iscsi and the
NFS client (Longhorn's node prerequisites), installs k3s at the server's own
version as an agent, and waits until the node is Ready.

```
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/add-node.sh | sudo sh -s -- ubuntu@10.0.0.21 ubuntu@10.0.0.22
```

- Run it as root on a server node: it reads the join token from
  `/var/lib/rancher/k3s/server/node-token`. The token is sent inside the script
  piped to the target over SSH, never on a command line or in the output.
- Each target needs SSH as root or as a user with passwordless sudo, `curl`,
  and outbound HTTPS. A failed login or a sudo that wants a password stops with
  the target named. A host already in the cluster is skipped.
- New nodes reach the server at `https://<this host's IP>:6443`; `--server-url`
  changes that. `--ssh-key` and `--ssh-port` set how to log in.
- `--server` joins them as additional servers instead. That needs a cluster
  started with embedded etcd (`--cluster-init`); the script refuses on a
  SQLite-backed server.

What runs on each node is `scripts/install/join-node.sh` (prerequisites, then
k3s with `K3S_URL`, `K3S_TOKEN` and `INSTALL_K3S_VERSION` from the
environment). `add-node.sh` carries a copy of it, kept in step by
`scripts/install/gen-scripts.sh`, so the same steps can be run on a node by
other means.

`install.sh` and `update.sh` also refresh the `k3s-join` Secret behind the
console's join links (see [Adding nodes from the console](#adding-nodes-from-the-console))
on every run, but only when run on the k3s server node; anywhere else they say
so and the console's node joining stays off.

## Testing the next branch

Work for the following round is built on the `next` branch. Its pushes publish
the image as `:next` and `:next.<run>` and the chart as `<base>-next.<run>` at
`oci://ghcr.io/<owner>/charts-next/<chartName>`, a separate path so the plain
installer, which takes the newest edge build, never picks one up. Select it
with `--channel next` on `install.sh` or `update.sh`; `--version` still pins a
build (`--channel next --version 0.1.1-next.7`).

```
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/update.sh | sh -s -- --channel next
```

Running the same command without `--channel next` moves the install back to
the newest edge build. Next builds can carry migrations that edge does not
know, so treat going back as a reinstall.

[testing-next.md](testing-next.md) walks through a test install, updates and
rolling back.

## Install with Helm

```
kubectl create namespace <ns>
kubectl -n <ns> create secret generic <secret> \
  --from-literal=SECRETS_KEY="$(openssl rand -hex 32)" \
  --from-literal=BOOTSTRAP_ADMIN_PASSWORD='<first sign-in password>'

helm upgrade --install <release> ./chart -n <ns> -f values.yaml \
  --set-string image.tag=<commit sha or edge>
```

Published artefacts (from `main`): the image at `ghcr.io/<owner>/<imageName>`
tagged `:<sha>` and `:edge`, and the chart as an OCI artefact at
`oci://ghcr.io/<owner>/charts/<chartName>` (`helm install <release> oci://... --version 0.1.1-edge.<n>`;
its `appVersion` is the commit sha, which is the default image tag).
`<imageName>` and `<chartName>` are in `product.json`. The packages are
public; in a fork, new ghcr packages stay private until made public in the
package settings.

`deploy/examples/values.yaml` is a starting values file.

## Values that matter

| Value                                                            | Purpose                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `config.publicOrigin`                                            | Externally visible origin (OIDC callback, Secure cookies). Optional: the setup wizard asks.     |
| `config.trustedProxies`, `config.clientIpHeader`                 | Take the client address from a header only when the peer is a listed proxy.                   |
| `secrets.existingSecret`                                         | Secret with `SECRETS_KEY` and `BOOTSTRAP_ADMIN_PASSWORD`. `secrets.create` is for tests only. |
| `persistence.*`                                                  | The data volume (`existingClaim`, `storageClass`, `size`). Kept on `helm uninstall`.          |
| `service.type`, `service.nodePort`                               | `ClusterIP` by default; with `NodePort`, `nodePort` (default 32450, 0 for random) fixes the port. |
| `ingress.*`, `networkPolicy.*`                                   | Off by default.                                                                               |
| `rollout.sameNode`                                               | Keeps the overlapping pods of a rollout on one node so a ReadWriteOnce volume can attach.     |
| `rbac.create`, `rbac.nodesProxy`, `rbac.secrets.*`               | See below.                                                                                    |
| `deploy.enabled`, `deploy.image`, `deploy.chartRef`              | App deploys from the console. Off by default; see "Deploying apps from the console".          |
| `terminationGracePeriodSeconds`, `config.drainMs`                | Shutdown drain; keep `drainMs` below the grace period.                                        |

## Access to the cluster

Everything is read-only. The ClusterRole covers nodes, namespaces, pods and
their logs, events, workloads (deployments, statefulsets, daemonsets,
replicasets, jobs, cronjobs), services, ingresses, PVCs, PVs, storage classes,
`metrics.k8s.io`, and, when the CRDs exist, Longhorn (volumes, nodes, replicas, snapshots, backups, settings), Velero, Fleet and
cert-manager objects. A missing CRD shows as "absent", not an error.

Two grants need a decision:

- **`rbac.nodesProxy`** (default on) lets the console read kubelet stats
  through the API server (`nodes/proxy`) for node and container metrics. On
  some Kubernetes versions that permission also reaches the kubelet's exec
  endpoints. Turn it off and metrics fall back to metrics-server.
- **`rbac.secrets.enabled`** (default off) is for TLS expiry from Secrets.
  RBAC cannot grant metadata only, so this lets the console read Secret
  contents. Limit it with `rbac.secrets.namespaces` (a Role per namespace)
  rather than cluster-wide.

## Deploying apps from the console

The Apps page and the setup wizard can install tools from a fixed catalog
(Headlamp, Longhorn, cert-manager, Authentik, Pocket ID and others). This is off by
default (`deploy.enabled: false`): the console detects what is installed and
shows the one command that turns deploys on, but changes nothing. Turn it on
with `install.sh --enable-deploy`, or:

```
helm upgrade <release> <chart> -n <ns> --reuse-values --set deploy.enabled=true
```

With it on, the chart adds:

- **An installer ServiceAccount**, `<release>-installer`, bound to
  `cluster-admin`. Each deploy is a Kubernetes Job in the console's namespace
  that runs `helm` or `kubectl` as this account. Charts such as cert-manager,
  Longhorn and Rancher create CRDs, cluster roles and webhooks, so anything
  narrower breaks real installs. Its token is never mounted in the console's
  own pod.
- **A Role in the console's namespace only**, for the console's own
  ServiceAccount: create, get, list, watch and delete Jobs, and create and
  delete Secrets (each deploy's values). No read of Secrets: the console never
  reads a values Secret back, and the namespace also holds its own
  `SECRETS_KEY`.

The read-only ClusterRole does not change.

**Trust note.** Anyone who can create Jobs (or Pods) in the console's namespace
can run them as the installer and so act as cluster-admin. Once deploys are on,
treat that namespace as the trust boundary: don't grant other people or tools
write access to it, and turn deploys off again (`--set deploy.enabled=false`)
when you no longer need them. Apps already installed stay installed.

`deploy.image` is the helm and kubectl image the Jobs run, pinned by digest.
Mirror it and change this value for an air-gapped cluster. `deploy.chartRef`
is only used to show the command above; it defaults to the chart's published
OCI location beside the image.

## Adding nodes from the console

On a k3s cluster set up by the installer, the console can hand out the command
that adds a machine. Open **Nodes** (or the wizard's cluster step), choose
**Make a join link**, and run the one-liner it shows on the new machine:

```
curl -fsSL 'https://console.example.test/join/<token>' | sudo bash
```

The script installs `open-iscsi` and the NFS client (what Longhorn and NFS
volumes need), checks it can reach the API server, then installs k3s at the
same version as the cluster and joins it as an agent. A cluster running
embedded etcd can also take a control-plane node: pick **Control plane**
before making the link. The node shows up under Nodes once it is Ready.

Each link works once and for one hour, and is served by the console itself at
`/join/<token>` with no sign-in, so the new machine needs to reach the console
at the address you opened it on, and that path must not sit behind a sign-in
proxy. Anyone holding an unused link can join a machine to the cluster: treat
it like a password, and prefer an HTTPS address. Unused links can be revoked
from the same panel.

The join values come from the Secret `k3s-join` in the console's namespace,
which the installer writes from the server's
`/var/lib/rancher/k3s/server/node-token` (keys `server-url`, `token`, and
`agent-token` when the cluster has a separate one). The chart lets the
console get that one Secret by name and nothing else; the token never appears
in the UI, the API or the logs. Without the Secret (a cluster not set up by
the installer) the panel says so and you can add nodes by hand, or run the
installer's `add-node.sh` on the new machine.

## Rollouts

Two pods overlap during every rollout. On shutdown the old pod's readiness
probe starts failing so the Service stops sending it work, new changes are
refused, and it waits up to `config.drainMs` for in-flight work; liveness keeps
passing so the drain isn't killed. The Deployment never takes the old pod away
before the new one is ready.

## Deploying from a Gitea pull mirror

CI is split: GitHub Actions tests every pull request, and on `main` publishes
the image and chart. A Gitea instance pull-mirrors the repository and its
runner deploys the mirrored chart to your cluster. The workflow and values live
in your own repository, not here; `deploy/examples/` has working starting
points.

One-time setup:

1. **Mirror.** In Gitea, add a pull mirror of this repository (interval 10
   minutes or less). Note its clone URL.
2. **Namespace and deployer.** Apply `deploy/examples/deployer-rbac.yaml`
   (`NAMESPACE=<ns> RELEASE=<release> envsubst < deployer-rbac.yaml | kubectl apply -f -`)
   and build a kubeconfig for the `deployer` ServiceAccount (a token from
   `kubectl -n <ns> create token deployer --duration=8760h`). It administers
   only its namespace plus the one cluster role the chart creates; read the
   comments in that file for the trade-off.
3. **Secrets for the install.** Create the `SECRETS_KEY` /
   `BOOTSTRAP_ADMIN_PASSWORD` Secret as under Install. For images from a
   private fork, add a pull secret
   (`kubectl -n <ns> create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=<user> --docker-password=<token with read:packages>`)
   and list it in `imagePullSecrets`.
4. **Values.** Copy `deploy/examples/values.yaml` and set the ingress host,
   `config.publicOrigin`, ingress class, cert issuer and storage class.
5. **Workflow.** Copy `deploy/examples/gitea-deploy.yaml` and
   `wait-for-image.sh` into your homelab repository, and set the variables
   `MIRROR_URL`, `NAMESPACE`, `RELEASE`, `IMAGE` and the secrets `KUBECONFIG`,
   `GHCR_USER`, `GHCR_TOKEN` (read:packages; only for a private fork) named in
   its header. It runs every ten minutes, deploys the
   mirror's HEAD once its image exists on ghcr, and does nothing when that
   commit is already deployed.
6. **Sign-in.** Entra ID, or any OIDC provider, is configured in the setup
   wizard or under Admin → Sign-in after the first local sign-in.

Not covered by the chart: SSH users for host checks and `scripts/capture-fixtures.sh`
are set up separately.

## After installing

1. Open the URL and sign in as `admin` with `BOOTSTRAP_ADMIN_PASSWORD` (the
   installer prints it; otherwise it is in the Secret you created). The
   password must be changed before anything else answers.
2. The setup wizard opens on its own for an admin until it is finished:
   - **Password**: the forced change, then the public URL people use to reach
     the console.
   - **Cluster**: what the ServiceAccount can read, and the grant or CRD each
     missing item needs. Missing items show as gaps, not errors.
   - **Access**: how you reach your apps (Cloudflare Tunnel, Tailscale, local
     network or direct ports) and the base domain, or the whole default
     bundle in one go. Needs deploys on to install anything.
   - **Sign-in**: issuer, client ID and secret for an OIDC provider, tested in
     place. Needs `SECRETS_KEY`. The redirect URI to register is shown.
   - **Links**: Rancher, Headlamp, Longhorn, Gitea and Grafana addresses, used
     for deep links from checks, workloads and category pages.
   - **Hosts**: a NAS or Linux box over SSH, with a connection test and its
     host key pinned.
   - **Checks**: a first HTTP check, run straight away.
   - **Alerts**: an ntfy, Discord or webhook channel, with a test message.
   - **Findings**: unprotected PVCs, nodes not Ready and failing backups.
   Every step but the last can be skipped. The wizard stays under **Setup** in
   the admin part of the sidebar.
3. `kubectl -n <ns> get secret <secret> -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d`
   reads the bootstrap password again. If you lose the admin password,
   `kubectl -n <ns> exec deploy/<release> -- node dist/platform/cli.js reset-admin`
   resets it (and its authenticator, network rules and password sign-in).

## Verifying a cluster install

```
kubectl -n <ns> rollout status deploy/<release>
kubectl auth can-i --list --as=system:serviceaccount:<ns>:<release>
```

The second command should show reads only (plus the self-review defaults every
account has), and with deploys on, Jobs and Secrets in `<ns>` as well. CI runs
the same checks against kind: `chart/ci/smoke.sh`, with `chart/ci/deploy-optin.sh`
checking the rendered chart both ways.
