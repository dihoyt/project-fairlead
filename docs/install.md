# Installing

The chart is `chart/` in this repository. It deploys one pod (SQLite on a
ReadWriteOnce volume), a Service, an optional Ingress and NetworkPolicy, and a
read-only ClusterRole. Nothing in the defaults is specific to an install.

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

While the repository and packages are private, fetch the script with a token
and pass `REGISTRY_USER` / `REGISTRY_TOKEN`; the steps and every flag are in
[scripts/install/README.md](../scripts/install/README.md).

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
`oci://ghcr.io/<owner>/charts/<chartName>` (`helm install <release> oci://... --version 0.1.0-edge.<n>`;
its `appVersion` is the commit sha, which is the default image tag).
`<imageName>` and `<chartName>` are in `product.json`. New ghcr packages are
private until made public in the package settings.

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
(Headlamp, Longhorn, cert-manager, Authentik and others). This is off by
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
   `BOOTSTRAP_ADMIN_PASSWORD` Secret as under Install. While the ghcr package is
   private, add a pull secret
   (`kubectl -n <ns> create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=<user> --docker-password=<token with read:packages>`)
   and list it in `imagePullSecrets`.
4. **Values.** Copy `deploy/examples/values.yaml` and set the ingress host,
   `config.publicOrigin`, ingress class, cert issuer and storage class.
5. **Workflow.** Copy `deploy/examples/gitea-deploy.yaml` and
   `wait-for-image.sh` into your homelab repository, and set the variables
   `MIRROR_URL`, `NAMESPACE`, `RELEASE`, `IMAGE` and the secrets `KUBECONFIG`,
   `GHCR_USER`, `GHCR_TOKEN` (read:packages; unneeded once the package is
   public) named in its header. It runs every ten minutes, deploys the
   mirror's HEAD once its image exists on ghcr, and does nothing when that
   commit is already deployed.
6. **Sign-in.** Entra ID, or any OIDC provider, is configured in the setup
   wizard or under Admin → Sign-in after the first local sign-in.

A worked example for one real cluster (Rancher, Longhorn, Fleet, Gitea, a NAS)
is [dogfood.md](dogfood.md).

Not covered by the chart: SSH users for host checks and `scripts/capture-fixtures.sh`
are set up separately.

## After installing

1. Open the URL and sign in as `admin` with `BOOTSTRAP_ADMIN_PASSWORD` (the
   installer prints it; otherwise it is in the Secret you created). The
   password must be changed before anything else answers.
2. The setup wizard opens on its own for an admin until it is finished:
   - **Cluster**: what the ServiceAccount can read, and the grant or CRD each
     missing item needs. Missing items show as gaps, not errors.
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
