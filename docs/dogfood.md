# Dogfood runbook

The first real install, on a homelab-sized cluster: k3s (`server-1`,
`agent-1`, `agent-2`) managed by Rancher, Longhorn for storage, Fleet
for GitOps, Gitea for git and CI, a NAS reached over SSH, Grafana, Headlamp.
No Velero. The goal is milestone A's done-test: **a fresh install in a new
namespace reaches a populated board and backup posture page through the setup
wizard alone.**

It deploys through the Gitea pull-mirror path in [install.md](install.md), so
every later merge to `main` rolls out by itself.

What the cluster looked like when this was written (read-only checks, 2026-10-07):

| | |
|---|---|
| Kubernetes | k3s v1.36.2 on `server-1` (10.0.0.20) and `agent-1` (.21); `agent-2` (.22) is on v1.36.4 |
| API server | `https://10.0.0.20:6443` (the admin kubeconfig points straight at it, not through Rancher) |
| Pod / Service CIDR | `10.42.0.0/16` / `10.43.0.0/16` (k3s defaults) |
| Ingress | `traefik`, the only and default class; ServiceLB on 10.0.0.20–22, ports 80/443 |
| cert-manager | installed; ClusterIssuers `letsencrypt-prod` and `letsencrypt-staging` |
| Storage classes | `longhorn` and `local-path`, **both** marked default; also `longhorn-static`, `nfs-nas` |
| Longhorn | 13 volumes; backup target `nfs://nas.example.lan:/volume1/backups`; recurring jobs `nightly-backups` (daily 10:00, keep 7, group `default`) and `weekly-system-backup` |
| Velero | not installed |
| Rancher / Fleet | this is Rancher's `local` cluster; GitRepo `fleet-local/scripts` from in-cluster Gitea |
| Gitea | `https://git.example.com/gitea`; in cluster `http://gitea-http.git.svc.cluster.local:3000` |
| Headlamp, Longhorn UI | `https://headlamp.example.com`, `https://longhorn.example.com` (all `*.example.com` except Rancher resolve to Cloudflare's proxy) |
| Grafana | not found in this cluster |

Hostnames, addresses and IDs below are examples (`example.com`, `10.0.0.0/24`).
Keep your real values in `docs/dogfood.local.md`, which is gitignored: copy
this file there and fill them in. Values still marked `# confirm` need a
decision before the first deploy.

Names used throughout: namespace and release `fairlead`, Secret
`fairlead-secrets`, host `fairlead.example.com`.

## 1. Before anything runs (once)

On a machine with `kubectl` admin access to the cluster:

```
export NS=fairlead RELEASE=fairlead

# Namespace, deployer ServiceAccount and its narrow RBAC
NAMESPACE=$NS RELEASE=$RELEASE envsubst < deploy/examples/deployer-rbac.yaml | kubectl apply -f -

# The install's secrets. Keep SECRETS_KEY somewhere safe: the database is sealed with it.
kubectl -n $NS create secret generic fairlead-secrets \
  --from-literal=SECRETS_KEY="$(openssl rand -hex 32)" \
  --from-literal=BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -base64 18)"

# Only while the ghcr packages are private (a classic PAT with read:packages)
kubectl -n $NS create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=dihoyt --docker-password=<PAT with read:packages>

# A kubeconfig for the deployer, for the Gitea secret below
TOKEN=$(kubectl -n $NS create token deployer --duration=8760h)
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
cat > deployer.kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters: [{name: c, cluster: {server: $SERVER, certificate-authority-data: $CA}}]
users: [{name: deployer, user: {token: $TOKEN}}]
contexts: [{name: deployer, context: {cluster: c, user: deployer, namespace: $NS}}]
current-context: deployer
EOF
KUBECONFIG=deployer.kubeconfig kubectl auth can-i create deployments -n $NS   # yes
KUBECONFIG=deployer.kubeconfig kubectl auth can-i create deployments -n default # no
```

`SERVER` comes out as `https://10.0.0.20:6443`, the k3s API itself, so the
deploy doesn't depend on Rancher. The Gitea runner must reach that address.

The other option is simply making both ghcr packages public (`fairlead` and
`charts/fairlead` under the GitHub profile's Packages → Package settings →
Change visibility); then drop `ghcr-pull` and the `GHCR_*` secrets below.

## 2. Gitea

1. **Mirror.** New migration → GitHub → `https://github.com/dihoyt/project-fairlead`,
   tick "This repository will be a mirror", interval `10m`. While the GitHub
   repo is private, give it a fine-grained GitHub token with read access to
   contents. Note the mirror's clone URL.
2. **Homelab repo.** In the repo that holds the cluster's manifests, add:
   - `.gitea/workflows/fairlead-deploy.yaml`: a copy of `deploy/examples/gitea-deploy.yaml`
   - `wait-for-image.sh` (executable): a copy of `deploy/examples/wait-for-image.sh`
   - `values.yaml`: the file in section 3

   The workflow reads the last two from the repo root. If that root is
   shared with other apps, put them in `fairlead/` and change
   `./wait-for-image.sh` and `--values values.yaml` in the workflow to match.
3. **Variables** (repo → Settings → Actions → Variables): `MIRROR_URL` (the
   mirror's clone URL), `NAMESPACE=fairlead`, `RELEASE=fairlead`,
   `IMAGE=dihoyt/fairlead`.
4. **Secrets** (repo → Settings → Actions → Secrets): `KUBECONFIG` (the
   contents of `deployer.kubeconfig`), `GHCR_USER=dihoyt` and `GHCR_TOKEN` (the
   read:packages PAT; skip once public), `MIRROR_TOKEN` if the mirror is private.
5. The runner needs network access to the k3s API and to ghcr.io. Run the
   workflow once by hand (`workflow_dispatch`) and watch it wait for the image,
   then `helm upgrade --install`.

## 3. values.yaml

```yaml
image:
  repository: ghcr.io/dihoyt/fairlead
imagePullSecrets:
  - ghcr-pull # remove once the package is public

config:
  publicOrigin: https://fairlead.example.com
  # Cloudflare proxies the host and names the client in CF-Connecting-IP;
  # Traefik forwards it from inside the cluster, so the peer is in the pod CIDR.
  trustedProxies: 10.42.0.0/16
  clientIpHeader: CF-Connecting-IP

secrets:
  existingSecret: fairlead-secrets

persistence:
  storageClass: longhorn # explicit: local-path is also marked default
  size: 2Gi

ingress:
  enabled: true
  className: traefik
  # No cert-manager: Cloudflare's edge holds the public certificate, and
  # Traefik answers the origin leg with its default TLS store.
  hosts:
    - host: fairlead.example.com

extraEnv:
  # Deep links; the wizard's Links step can set these instead.
  - name: RANCHER_URL
    value: https://rancher.example.com
  - name: RANCHER_CLUSTER_ID
    value: local # Rancher's own cluster; a downstream registration is c-xxxxx

rbac:
  nodesProxy: true # kubelet stats: PVC usage, node and container metrics
```

DNS goes through Cloudflare, like the other `*.example.com` hosts:

1. In the `example.com` zone, add a **proxied** (orange cloud) record
   `fairlead` pointing at the same origin as `git.example.com`. `# confirm`
   the origin: the home's public address forwarded to Traefik on 443, or a
   Cloudflare Tunnel hostname if that's how `*.example.com` arrives.
2. SSL/TLS mode **Full**: Traefik's default certificate is for
   `*.k3s.example.com`, which Full accepts and Full (strict) does not. For
   strict, add a Cloudflare Origin Certificate for `fairlead.example.com` as a
   TLS Secret and a `tls` block in the ingress.

`CF-Connecting-IP` is believed from anything in the pod CIDR, so anyone on the
LAN who reaches Traefik directly (10.0.0.20–22) could claim any address.
That only matters once per-user trusted networks are in use; firewall 443 on
the nodes to Cloudflare's ranges if it does.

The Longhorn volume is backed up like any other PVC once a recurring job
covers the `fairlead` namespace, which the posture page will show.

## 4. NAS and one Linux box (for the Hosts step)

Same on both, as user `monitor`:

1. Create the user with a real shell (`/bin/sh` or `/bin/bash`).
2. `ssh-keygen -t ed25519 -N '' -f monitor_ed25519` on your workstation. In
   the user's `~/.ssh/authorized_keys`:
   `restrict,from="10.0.0.20,10.0.0.21,10.0.0.22" ssh-ed25519 AAAA… monitor`
3. Disk health (SMART) needs root:
   - Linux: in sudoers, `monitor ALL=(root) NOPASSWD: /usr/sbin/smartctl -j -H -A -d * /dev/*, /usr/sbin/smartctl -H -A -d * /dev/*, /usr/sbin/smartctl --scan`
   - TrueNAS SCALE: the user's "Allowed sudo commands with no password" = `/usr/sbin/smartctl`; turn on the SSH service.
   - Synology DSM: SSH only admits the `administrators` group, so use an
     admin-group user locked down by the `restrict,from=` line, and a sudo
     rule for `/usr/bin/smartctl` (DSM updates may undo it).
   Without it, SMART reads "unknown" and everything else still works.
4. The NAS folder Longhorn's backup target writes to is `/volume1/backups`
   (target `nfs://nas.example.lan:/volume1/backups`), for "Backup folders".

## 5. First sign-in and the wizard

```
kubectl -n fairlead rollout status deploy/fairlead
kubectl -n fairlead get secret fairlead-secrets -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d; echo
```

Open `https://fairlead.example.com`, sign in as `admin`, set a new password.
The wizard opens. Go through every step without leaving it:

| Step | Do | Expect |
|---|---|---|
| Cluster | Read the list | Core, workloads, `nodes/proxy`, Longhorn and Fleet readable. Velero "not installed". cert-manager readable if installed. Nothing "denied". |
| Sign-in | Entra ID: issuer `https://login.microsoftonline.com/<tenant id>/v2.0`, client ID and secret of a new app registration whose redirect URI is the one shown (`https://fairlead.example.com/auth/oidc/callback`), admin group = an Entra group's object ID. Save and test | "Provider reachable". Then sign out and back in with Entra in a private window: you land as an admin. |
| Links | Rancher `https://rancher.example.com`, cluster ID `local`, Headlamp `https://headlamp.example.com`, Longhorn UI `https://longhorn.example.com`, Gitea `https://git.example.com/gitea`; Grafana blank unless it runs elsewhere | Saved; links appear on category pages. |
| Hosts | The NAS with the `monitor` key, kind Detect, backup folder from 4.4. Test, compare the host key fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the NAS, add | Connected, kind detected (Synology/TrueNAS/Linux), checks listed. |
| Checks | `https://git.example.com/gitea` | A result with status, latency and certificate days left (Cloudflare's edge certificate). |
| Alerts | ntfy (topic of your phone) or Discord webhook. Add and send a test | The test arrives on the phone. |
| Findings | Read | Counts match what you know: unprotected PVCs, nodes not Ready (0), failed backups. Finish lands on the board. |

## 6. What to verify on each page

Note anything wrong as an issue in `dihoyt/project-fairlead` with a screenshot and
the raw data the page shows for it.

- **Health board**: tiles for Cluster, Storage, Backups, GitOps, Hosts, Checks
  populated within a couple of minutes; Velero shown as absent, not as a
  failure. Every failing check shows its raw data.
- **Cluster**: three nodes Ready; any CrashLoopBackOff or long-Pending pods
  you know of are listed; PVC usage numbers plausible against
  Longhorn's UI; links open Rancher's cluster explorer. *Version skew* should
  note `agent-2` on v1.36.4 against v1.36.2 elsewhere (within policy).
- **Storage (Longhorn)**: every volume's robustness matches Longhorn's UI;
  degraded volumes and node disks listed; snapshot counts plausible.
- **Backups (posture page)**: every PVC in the cluster is a row (13 Longhorn
  volumes, plus any `local-path` or `nfs-nas` claims, which no source covers);
  Longhorn recurring-job coverage and last good backup match Longhorn → Backup; PVCs
  without a recurring job are at the top as unprotected; target free space
  shows once the NAS host's backup folder is set; CSV export opens.
- **GitOps (Fleet)**: GitRepo `fleet-local/scripts` and its 15 bundle
  deployments; states match Rancher → Continuous Delivery. This cluster runs
  Rancher, so its GitRepos are here; a downstream cluster's install would read
  "absent".
- **Nodes**: CPU, memory, disk and network charts for each node with an
  hour of history after an hour; container metrics per pod.
- **Hosts**: NAS charts fill in; disk, RAID or pool, SMART (or "unknown" with
  the reason) and temperatures.
- **HTTP checks**: the Gitea check stays green; certificate expiry days right.
- **Workloads**: browse a namespace, a deployment, its pods, events and logs;
  a log line containing an env secret is masked; Rancher and Headlamp links
  open the same object.
- **Notifications**: break something harmless (scale a test deployment to an
  image that doesn't exist) and get one alert after about 90 seconds, then a
  recovery when it's fixed.
- **Rollout**: merge any small change to `main`; within about 20 minutes the
  Gitea workflow deploys it, the old pod drains, and you stay signed in.
- **Access**: `kubectl auth can-i --list --as=system:serviceaccount:fairlead:fairlead`
  shows reads only.

## 7. Undo

```
helm -n fairlead uninstall fairlead      # keeps the PVC and Secret
kubectl delete namespace fairlead        # everything, including the data
kubectl delete clusterrole,clusterrolebinding fairlead-fairlead
```

Disable the Gitea workflow first, or it reinstalls within ten minutes.
