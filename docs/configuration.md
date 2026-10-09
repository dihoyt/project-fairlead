# Configuration

Three layers, read in this order:

1. **Bootstrap and security variables** are environment only. They are shown
   read-only under Admin → Settings and can't be changed from the UI.
2. **Settings** are changed under Admin → Settings (or by the setup wizard).
   A value set there wins over the environment variable, which wins over the
   default, except for the public URL, where `PUBLIC_ORIGIN` wins. Every setting is read fresh on each use, so a change needs no
   restart. Resetting a setting in the UI falls back to the variable.
3. **Kubernetes permissions** decide what the console can see at all; see
   "Permissions by feature" below.

In the chart, `config.publicOrigin` sets `PUBLIC_ORIGIN` (see the public URL
below), `config.trustedProxies` and `config.clientIpHeader` set the first two
variables below, every key of the
Secret named in `secrets.existingSecret` becomes a variable, and anything else
goes in `extraEnv`:

```yaml
extraEnv:
  - name: ADMIN_GROUPS
    value: homelab-admins
  - name: RANCHER_URL
    value: https://rancher.example.com
```

No variable carries a product prefix.

## Environment only

| Variable | Purpose |
|---|---|
| `TRUSTED_PROXIES` | Comma-separated addresses or CIDRs whose client-IP header is believed. |
| `CLIENT_IP_HEADER` | The header carrying the client address from a trusted proxy, e.g. `X-Forwarded-For`. |
| `SECRETS_KEY` | Encrypts every secret stored in the database (OIDC client secret, SSH credentials, notification URLs, check auth headers). Without it nothing can be stored. **Never change it on an existing install**: what it sealed can't be read back. `openssl rand -hex 32`. |
| `BOOTSTRAP_ADMIN_PASSWORD` | First boot only: the password of the `admin` account, which must be changed at first sign-in. Ignored once any account exists. |
| `ADMIN_USERS`, `ADMIN_GROUPS` | Comma-separated usernames or emails, and groups, that are always admins. |
| `DATA_DIR` | Where the database lives (the chart mounts the volume here). |
| `DB_PATH` | Overrides the database file's location outright. |
| `DRAIN_MS` | How long a pod being replaced waits for in-flight work (chart: `config.drainMs`, default 600000). Keep it below `terminationGracePeriodSeconds`. |
| `PORT`, `HOST` | Listen address; the chart sets `PORT=8080`. |
| `GIT_SHA` | The build, reported by `/healthz`; set in the image. |
| `KUBECONFIG`, `KUBE_CONTEXT` | Outside a cluster: the kubeconfig and context to use. Empty in a pod: its ServiceAccount. |
| `HEALTH_DEMO` | `1` adds a provider that cycles through every status, for trying the board without a cluster. |
| `DEV_AUTH` | Development only: signs every request in as an admin. Refused when `NODE_ENV=production`, which the image sets. |

## Settings

Grouped by the part that declares them. "Env" is the variable that sets it when
the UI hasn't.

### Site and sign-in

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `site.name` | `SITE_NAME` | product name | Browser tab, sign-in page and header. |
| `site.publicUrl` | `PUBLIC_ORIGIN` | empty | Where browsers reach this install, e.g. `https://console.example.com`. Sets the OIDC redirect URI (`<public URL>/auth/oidc/callback`). See below. |
| `auth.password.enabled` | `AUTH_PASSWORD_ENABLED` | `true` | Allow local password sign-in. Can't be turned off before OIDC has worked for you. |
| `auth.password.networks` | `AUTH_PASSWORD_NETWORKS` | none | CIDRs password sign-in is allowed from. Empty: anywhere. |
| `auth.totp.enabled` | `AUTH_TOTP_ENABLED` | `false` | Allow authenticator apps for local accounts. Needs `SECRETS_KEY`. |
| `auth.totp.require` | `AUTH_TOTP_REQUIRE` | `none` | Who must enrol an authenticator at next sign-in. |
| `auth.oidc.enabled` | `OIDC_ENABLED` | `false` | Allow OIDC sign-in. |
| `auth.oidc.label` | `OIDC_LABEL` | `Sign in with SSO` | Button text. |
| `auth.oidc.issuer` | `OIDC_ISSUER_URL` | | Issuer URL; discovery is read from it. Entra ID: `https://login.microsoftonline.com/<tenant>/v2.0`. |
| `auth.oidc.clientId` | `OIDC_CLIENT_ID` | | Client ID. The secret is set in the UI only and never shown again. |
| `auth.oidc.scopes` | `OIDC_SCOPES` | `openid profile email` | |
| `auth.oidc.usernameClaim` | `OIDC_USERNAME_CLAIM` | `preferred_username` | |
| `auth.oidc.groupsClaim` | `OIDC_GROUPS_CLAIM` | `groups` | Entra ID sends group object IDs unless the app registration emits names. |
| `auth.oidc.autoProvision` | `OIDC_AUTO_PROVISION` | `false` | Create accounts at first OIDC sign-in. Off: an admin creates the account (no password) and the first matching sign-in links to it. |
| `auth.oidc.allowedGroups` | `OIDC_ALLOWED_GROUPS` | none | Only these groups may sign in through OIDC. |
| `auth.oidc.adminGroups` | `OIDC_ADMIN_GROUPS` | none | Members are admins while signed in through OIDC. |
| `auth.oidc.allowedEmails` | `OIDC_ALLOWED_EMAILS` | none | Only these verified addresses (`ann@example.com`) or domains (`@example.com`) may sign in through OIDC. Google and Microsoft multi-tenant sign-in create no accounts while this and allowed groups are both empty. |
| `auth.oidc.adminEmails` | `OIDC_ADMIN_EMAILS` | none | A verified OIDC sign-in with one of these addresses or domains makes the account an admin (never demoted automatically). |
| `auth.oidc.networks` | `OIDC_NETWORKS` | none | CIDRs OIDC sign-in is allowed from. |
| `auth.oidc.recheckHours` | `OIDC_RECHECK_HOURS` | `0` | Send OIDC sessions back through the provider this often. |
| `auth.session.idleDays` | `SESSION_IDLE_DAYS` | `14` | Sign out after this much inactivity. |
| `auth.session.maxDays` | `SESSION_MAX_DAYS` | `30` | Absolute session lifetime. |

#### Google and Microsoft accounts

The Sign-in step offers **Google** and **Microsoft** beside the generic form.
Neither needs anyone invited to a tenant: you make one OAuth client, and anyone
whose verified email is on the allowed list can sign in with their own account.

- Google: in Google Cloud Console, APIs & Services, Credentials, create an
  OAuth client ID of type Web application with the redirect URI
  `<public URL>/auth/oidc/callback`. Issuer `https://accounts.google.com`.
- Microsoft: in Entra, App registrations, New registration, pick "Accounts in
  any organizational directory and personal Microsoft accounts", platform Web,
  the same redirect URI, then add a client secret. Issuer
  `https://login.microsoftonline.com/common/v2.0`; each token's issuer names
  the user's own tenant and is checked against it. A work account's email
  counts as verified only with the `xms_edov` optional claim (Token
  configuration, Add optional claim, ID, `xms_edov`); personal accounts always
  count.

The preset saves the allowed and admin email lists and turns on account
creation at first sign-in; it refuses an empty allowed list.

#### Public URL

Set it at the first setup step or under Admin, Settings, General. The setup
step is prefilled with the address you opened the page on.

- `PUBLIC_ORIGIN` in the environment (chart `config.publicOrigin`, or
  `install.sh --origin`) overrides it, and the field is then read-only.
- With neither set, the redirect URI is shown from the address of the current
  request (a forwarded scheme and host count only from a peer in
  `TRUSTED_PROXIES`), but OIDC sign-in stays off until a URL is saved.
- Secure (`__Host-`) session cookies follow `PUBLIC_ORIGIN` only, so a wrong
  value saved from the UI can't lock anyone out. Behind https, set
  `PUBLIC_ORIGIN` as well to get them.

### Health board and notifications

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `health.rules` | `HEALTH_RULES` | `{}` | Per-check overrides keyed `"<provider>/<check>"` or `"<provider>/*"`: `warnAbove`, `critAbove`, `warnBelow`, `critBelow`, `maxStatus: "warn"` (cap a check's severity) or `disabled: true`. |
| `health.links` | `HEALTH_LINKS` | `{}` | Links on each category page: `{"storage": [{"label": "Longhorn", "url": "https://…"}]}`. The wizard's Links step writes Rancher, Headlamp, Grafana, Longhorn and Gitea here and keeps any others. |
| `health.historyDays` | `HEALTH_HISTORY_DAYS` | `30` | How long check history is kept. |
| `notify.debounceSeconds` | `NOTIFY_DEBOUNCE_SECONDS` | `90` | A change is sent once it has held this long; a flap inside it sends nothing. |
| `notify.maxHoldSeconds` | `NOTIFY_MAX_HOLD_SECONDS` | `900` | A check that keeps flapping is sent with its current status after this long. |

### Cluster, nodes and workloads

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `cluster.podPendingMinutes` | `CLUSTER_POD_PENDING_MINUTES` | `15` | Report a pod still Pending after this long. |
| `cluster.pvcPendingMinutes` | `CLUSTER_PVC_PENDING_MINUTES` | `15` | Same for PVCs. |
| `cluster.restartSpikeCount`, `cluster.restartSpikeMinutes` | `CLUSTER_RESTART_SPIKE_COUNT`, `…_MINUTES` | `5`, `60` | Report a container restarting this often within the window. |
| `cluster.certWarnDays`, `cluster.certCritDays` | `CLUSTER_CERT_WARN_DAYS`, `…_CRIT_DAYS` | `14`, `7` | cert-manager certificate expiry. |
| `cluster.volumeWarnPercent`, `cluster.volumeCritPercent` | `CLUSTER_VOLUME_WARN_PERCENT`, `…_CRIT_PERCENT` | `80`, `90` | PVC usage from kubelet stats (needs `nodes/proxy`). |
| `cluster.rancherUrl` | `CLUSTER_RANCHER_URL` | | Rancher cluster explorer URL for deep links, e.g. `https://rancher.example.com/dashboard/c/local/explorer`. |
| `cluster.headlampUrl` | `CLUSTER_HEADLAMP_URL` | | Headlamp cluster URL, used when no Rancher URL is set, e.g. `https://headlamp.example.com/c/main`. |
| `metrics-k8s.memoryWarnPercent`, `…CritPercent` | | `85`, `95` | Node memory against allocatable. |
| `metrics-k8s.diskWarnPercent`, `…CritPercent` | | `80`, `90` | Node filesystem. |
| `workloads.rancherUrl` | `RANCHER_URL` | | Rancher's base URL for links from the workload browser. |
| `workloads.rancherClusterId` | `RANCHER_CLUSTER_ID` | `local` | This cluster's ID in Rancher (`local` where Rancher runs, else `c-xxxxx`). |
| `workloads.headlampUrl` | `HEADLAMP_URL` | | Headlamp's base URL. |
| `workloads.headlampCluster` | `HEADLAMP_CLUSTER` | `main` | The cluster's name in Headlamp URLs. |

### Storage, backups and GitOps

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `longhorn.uiUrl` | `LONGHORN_UI_URL` | | Longhorn UI for links from checks. |
| `longhorn.backupGraceMinutes` | `LONGHORN_BACKUP_GRACE_MINUTES` | `120` | How long after a scheduled run its backup may still be missing. |
| `velero.graceMinutes` | `VELERO_GRACE_MINUTES` | `60` | How late a schedule may fire before it counts as missed. |
| `velero.restoreMaxAgeDays` | `VELERO_RESTORE_MAX_AGE_DAYS` | `90` | Warn when the last completed restore is older than this. |
| `backups.ignore` | | none | PVCs not expected to be backed up: a namespace (`cache`) or `namespace/pvc`. Uncovered matches show as ignored rather than critical. |
| `backups.warnFactor`, `backups.critFactor` | | `1.5`, `4` | How many policy intervals old the last good backup may be before warning or critical. |
| `backups.targetFreeWarnPercent` | | `10` | Warn when a backup target's free space falls below this share. `0` turns it off. |
| `fleet.rancherUrl` | `RANCHER_URL` | | Rancher running Fleet; checks link into Continuous Delivery. Empty: links go to the git host. |
| `fleet.graceMinutes` | `FLEET_GRACE_MINUTES` | `10` | How long a bundle may be NotReady, OutOfSync, WaitApplied or Pending before full severity. |
| `fleet.severity` | `FLEET_SEVERITY` | `{}` | Severity per Fleet state, e.g. `{"Modified": "ok"}`. |

`RANCHER_URL` feeds both `workloads.rancherUrl` and `fleet.rancherUrl`.

### Hosts

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `hosts.intervalSeconds` | `HOSTS_INTERVAL_SECONDS` | `60` | How often each host is visited over SSH. |
| `hosts.diskWarnPercent`, `hosts.diskCritPercent` | | `85`, `95` | Filesystem usage. |
| `hosts.loadWarnPerCpu` | | `2` | One-minute load per CPU. |

Hosts, HTTP checks and notification channels themselves are records, not
settings: add them on their pages or in the wizard.

### Retention

Metrics are kept raw for a day, at 5-minute resolution for 30 days and hourly
for a year (fixed). Check history follows `health.historyDays`.

## Reset to defaults

Admin > Settings ends with a **Reset to defaults** section: it clears the app's own configuration without a reinstall. Tick what to clear, type `RESET`, and confirm. The database changes commit together; stored secrets (host credentials, channel tokens, check headers) are removed right after.

| Box | Clears |
|---|---|
| Settings | Every setting changed in the UI, back to its environment value or default. Sign-in and public URL settings are kept, so a reset cannot lock you out. |
| Native UI links | The links shown on the category pages (Rancher, Longhorn, Headlamp, ...). |
| HTTP checks | Every check, with its stored header secret. |
| Hosts | The host inventory and its stored credentials. |
| First-run wizard | The done and skipped marks. The wizard opens again on the next page load. |
| Notifications | Channels with their secrets, and the queued and sent history. |
| Generated SSH key | The install's key pair. Off by default; hosts that trust it stop being reachable until the new key is installed. |
| Built-in admin password | Gives the `admin` account a new temporary password, shown once, to be changed at its next sign-in. Off by default. |

Not touched: apps deployed into the cluster (including by the bundle), the deploy history, the cluster itself, user accounts other than the password above, and values set by environment variables. `POST /api/system/reset` does the same for scripts: body `{"scopes": ["settings", ...], "confirm": "RESET"}`, admin only; each reset is recorded in the audit log as `system.reset`.

## Permissions by feature

The chart's ClusterRole grants all of this read-only (`get`, `list`, `watch`;
`get` only for `nodes/proxy` and `metrics.k8s.io`). The Cluster step of the
wizard, and `GET /api/k8s/capabilities`, show which of these the ServiceAccount
actually has and what is missing. A group whose CRDs aren't installed shows as
"absent", never as an error, so installing Longhorn later needs no change here.

| Feature | Reads | Without it |
|---|---|---|
| Cluster health (nodes, pods, PVCs) | `nodes`, `pods`, `persistentvolumeclaims`, `persistentvolumes`, `events`, `namespaces` | Cluster tile is empty. |
| PVC usage, node and container metrics | `nodes/proxy` (`get`): the kubelet Summary API through the API server. Chart: `rbac.nodesProxy` (default on). | Volume usage checks and container metrics are missing; node metrics fall back to `metrics.k8s.io` where served. |
| Node metrics fallback | `metrics.k8s.io` `nodes`, `pods` | Nothing, if `nodes/proxy` is granted. |
| Certificate expiry | `cert-manager.io` `certificates` | No certificate checks. |
| TLS expiry from Secrets | `secrets` (`rbac.secrets.enabled`, default off; scope it with `rbac.secrets.namespaces`) | Only cert-manager certificates are checked. RBAC can't grant metadata only, so this reads Secret contents. |
| Longhorn storage and backups | `longhorn.io` `volumes`, `nodes`, `replicas`, `snapshots`, `backups`, `backupvolumes`, `backuptargets`, `recurringjobs`, `settings` | Storage tile shows Longhorn as absent; Longhorn-protected PVCs read as unprotected. |
| Velero backups | `velero.io` `backups`, `schedules`, `restores`, `backupstoragelocations` | Velero absent. |
| Backup posture | the Longhorn and Velero reads above, plus `persistentvolumeclaims`, `pods` (which workload mounts a PVC) | |
| Fleet GitOps | `fleet.cattle.io` `gitrepos`, `bundles` | GitOps tile absent. |
| Workload browser | `namespaces`, `deployments`, `statefulsets`, `daemonsets`, `replicasets`, `jobs`, `cronjobs`, `pods`, `events`, `pods/log`; `secrets` (`get`, only with the opt-in `rbac.secrets` grant) to mask the pod's own Secret values in its logs | Pages for the missing kinds are empty; logs unavailable without `pods/log`. |
| Hosts, HTTP checks, notifications | nothing in the cluster; outbound SSH and HTTP(S) from the pod | |

**`nodes/proxy`** is the one grant worth a decision: on some Kubernetes versions
it also reaches the kubelet's exec endpoints. With `rbac.nodesProxy: false`
the console still works and says which checks need it.

Network: the pod needs to reach the API server, any host it checks over SSH
(port 22 by default), the URLs of HTTP checks and notification channels, and
the OIDC issuer. With `networkPolicy.enabled` only ingress is restricted.
