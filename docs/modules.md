# Modules

Each part of the console is a module. Most read something, judge it, and
report into the shared health board, metrics store or backup posture; the
ones under "Setting up and running the cluster" also change things, always
through the deploy runner. This page says what each one watches or does,
where it shows up, and what it needs.
Settings are listed with their defaults in [configuration.md](configuration.md).

Every health check has a status: **ok**, **warn**, **crit**, **unknown** (could
not be judged; the detail says why) or **absent** (the thing isn't installed,
hidden by default and never counted as a failure). Every result carries a
detail line, and a failing one carries the raw data it was judged on. Any
check can be retuned or silenced with `health.rules`, keyed
`<provider>/<check>`.

## Kubernetes connection (`k8s`)

Connects to the cluster: an explicit `KUBECONFIG`, else the pod's
ServiceAccount, else `~/.kube/config`. Every other module reads the cluster
through it.

- **Board** (Cluster): *API server* (crit when unreachable, unknown when no
  connection is configured) and *Read access* (warn when a served API group
  is missing a read grant).
- **Capabilities**: `GET /api/k8s/capabilities` runs an access review for
  every resource the console reads, plus `nodes/proxy` and `pods/log`, every
  10 minutes. The setup wizard's Cluster step shows it. A group whose CRDs
  aren't installed is "install X", not a permissions problem.

## Health board (`health`)

Runs every provider on its own interval, keeps the latest results and their
history, and emits a change event that notifications consume.

- **Pages**: `/health` (tiles for Cluster, Storage, Backups, GitOps, Hosts,
  Checks) and `/health/<category>` (every check, a history strip, links set in
  `health.links`).
- History is kept for `health.historyDays` (30). An unchanged check still
  records a point every hour.
- Only one pod collects at a time (a lease in the database), so the two pods
  of a rollout don't double up. A provider silent for three intervals reads as
  unknown, "stale since …".

## Metrics store (`metrics`)

The time series behind every chart. Other modules write samples; nothing is
scraped from Prometheus.

- Raw samples for a day, 5-minute rollups for 30 days, hourly rollups for a
  year. Queries pick the coarsest resolution that fits the range.
- `GET /api/metrics/query`, `GET /api/metrics/series`.

## Notifications (`notify`)

Sends health changes to **email**, **ntfy**, **Discord** or a **webhook** (a
JSON POST).

- **Page**: Admin → Notifications. Each channel has a minimum severity (warn
  or crit) and a test button. A recovery is sent only to channels that were
  told about the problem.
- A change is held for `notify.debounceSeconds` (90) and dropped if it flaps
  back; a check that keeps flapping is sent with its current status after
  `notify.maxHoldSeconds` (900). Failed deliveries retry three times.
- Channel URLs, tokens, passwords and sign-ins are stored encrypted and never
  shown again.

### Email

One mail per status change, HTML with a plain-text part, to up to 20
addresses. Pick how it is sent with **Send with**:

- **App password (SMTP)**: Gmail / Google Workspace, Yahoo, iCloud, Fastmail,
  or a sending service (SendGrid, Mailgun, Amazon SES) or any other SMTP
  server. Gmail needs 2-Step Verification on the account and an app
  password from myaccount.google.com/apppasswords; Workspace admins can turn
  app passwords off. There is no Microsoft SMTP preset: Outlook.com takes no
  passwords over SMTP, and Exchange Online turns basic SMTP sign-in off by
  default from the end of December 2026.
- **Sign in to send**: a Google account (Gmail) or a Microsoft account
  (Outlook.com, Hotmail, Microsoft 365) signs in once and mail goes out as
  that account, through the Gmail API (`gmail.send` scope) or Microsoft Graph
  (delegated `Mail.Send`). It needs an OAuth client of your own, the same
  kind the Google and Microsoft sign-in presets use (you can use that same
  client; its id is filled in). Add the redirect URI the form shows,
  `<public URL>/api/notify/oauth/callback`, to the client, and sign in from
  the console's public address.
  - Google: a Web application client in Google Cloud Console with the Gmail
    API enabled. Set the OAuth consent screen to **In production** (or
    **Internal** on Workspace): in Testing, Google ends the sign-in after 7
    days. An unverified production app shows a warning screen to whoever
    signs in, which is expected for your own client.
  - Microsoft: an Entra app registration for "any organizational directory
    and personal Microsoft accounts", a Web redirect URI, a client secret,
    and the delegated Microsoft Graph permission `Mail.Send`.
- **Microsoft 365 through the Entra connector**: no sign-in. Mail is sent with
  the connector's management app (Admin > Connectors) as the From mailbox. A
  tenant admin lets that app send as that one mailbox with Exchange Online's
  RBAC for Applications, in Exchange Online PowerShell:

  ```powershell
  New-ServicePrincipal -AppId <management app client id> -ObjectId <its enterprise app object id> -DisplayName "Console mail"
  New-ManagementScope -Name "Console mailbox" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'alerts@example.com'"
  New-ManagementRoleAssignment -App <management app client id> -Role "Application Mail.Send" -CustomResourceScope "Console mailbox"
  ```

  Don't grant the Graph application permission `Mail.Send` instead: that
  lets the app send as every mailbox in the tenant.

**Send a test** shows the server's own reply when it fails (the SMTP reply
line, or the provider's error). A sign-in that was revoked or expired shows
as a failing channel; sign in again from its row.

## Cluster (`cluster`)

Judges the cluster's own objects. **Board**: Cluster.

- Checks: *Nodes ready*, *Node pressure*, *Crashing pods*, *Image pulls*,
  *Pending pods*, *Restart spikes*, *Volume claims*, *Volume usage*,
  *Certificates* (cert-manager), *Control plane*, *Cluster DNS*, *Version
  skew*.
- Reads nodes, pods, PVCs and cert-manager certificates; PVC usage comes from
  each Ready node's kubelet stats (`nodes/proxy`).
- Deep links go to Rancher's cluster explorer (`cluster.rancherUrl`), else
  Headlamp (`cluster.headlampUrl`), else the in-app workload browser.
- Restart spikes are counted in memory, so the first window after a restart
  reports nothing.

## Node and container metrics (`metrics-k8s`)

Usage from each node's kubelet Summary API, with metrics-server as the
fallback for a node whose kubelet can't be read.

- **Page**: `/nodes`, one row per node: name and role, Ready / Cordoned /
  Not Ready with a dot for memory, disk or PID pressure, kubelet version with
  a *drift* badge when it differs from the API server, uptime, pods against
  capacity, and a 30-minute sparkline with the current value for CPU,
  memory, disk, network in and out, load (nodes that are also under Hosts)
  and, when Longhorn is installed, its schedulable space left. A new node is
  a new row. Click a row for its CPU, memory, disk and network charts; the
  node's own page adds its pods' containers. The default storage class and
  *Add a node* sit above the table.
- Row data comes from the node object, the kubelet summary already read for
  the series below, Longhorn's Node objects, and the stored series (no extra
  collectors). A node is matched to a Hosts entry by address (InternalIP,
  ExternalIP or hostname); uptime falls back to the host's when the kubelet
  doesn't report a start time.
- **Board** (Cluster): *Memory on &lt;node&gt;*, *Disk on &lt;node&gt;* (absent
  on the metrics-server fallback, which has no disk data), *Node usage data*
  (warn when Ready nodes have no data).
- Series every 30 s: `node.cpu.percent`, `node.memory.percent`,
  `node.fs.percent`, network rates, pod counts; `container.cpu.percent`
  (percent of one core), `container.memory.bytes`, `container.restarts.count`.
- Needs `get` on `nodes/proxy`; a 403 is reported as exactly that.

## Node actions (`deploy`)

Cordon, uncordon, drain and reboot, from a node's **Actions** menu on the
Nodes page (admins) or the MCP tools `plan_node_action`, `cordon_node`,
`uncordon_node`, `drain_node` and `reboot_node`. Each one is previewed first
and runs as a deploy Job under the installer service account, so it needs
deploys turned on (the dialog shows the command that turns them on
otherwise); the console's own service account stays read-only. The Job is
kept off the node it acts on, its log is the progress, and it shows in the
deploy job list as `node-<name>`. One action per node runs at a time.

- **Drain** is `kubectl drain` through the eviction API, so
  PodDisruptionBudgets are respected. The preview lists every pod on the node
  and what happens to it: moves, stays (DaemonSet and static pods), waits (on
  a named PodDisruptionBudget that allows no disruption right now) or blocks
  (no controller, an emptyDir volume, or a DaemonSet when those aren't left
  in place). A blocking pod refuses the drain up front; there is no force
  option. Options: leave DaemonSet pods in place (default on), evict pods
  with emptyDir volumes (default off), how long evictions may wait (30 to
  3600 s, default 300). If the drain stops, the log names the budgets that
  held it and the node stays cordoned.
- **Reboot** drains, then starts a short-lived privileged pod pinned to the
  node in `kube-system` that runs `systemctl reboot` in the host's
  namespaces (`nsenter` into PID 1, a fixed command in code). It waits up to
  15 minutes for the node to come back Ready with a new boot ID, deletes the
  pod and uncordons the node. Offered for every Ready node; no SSH key is
  involved. A node that doesn't come back stays cordoned.
- The only node of a cluster is never drained or rebooted (cordon is still
  allowed). The preview warns when the node runs the console's own pod (it
  moves and the page reconnects), when no other node can take the pods, and
  when rebooting the only control-plane node takes the API down for a while.
- The chart's read-only role includes `get`/`list` on
  `policy/poddisruptionbudgets` so the preview can name budgets; on an older
  chart the preview just has no "waits" rows.

## Longhorn (`longhorn`)

**Board**: Storage (*Longhorn volumes*) and Backups (*Longhorn backups*).
Absent when Longhorn isn't installed.

- Storage: each volume's robustness and replicas, each Longhorn node and its
  disks, snapshot counts.
- Backups: backup targets, each recurring job, *Volumes without a backup job*,
  and the age of each volume's last backup against its job's schedule (one
  missed run warns, two are critical; `longhorn.backupGraceMinutes` of grace).
- Feeds the backup posture as the "Longhorn" source, and writes volume size
  series.

## Velero (`velero`)

**Board**: Backups. Absent when Velero's CRDs aren't installed.

- Checks: storage locations, each schedule and its last backup (late after
  `velero.graceMinutes`), other backups in the last 7 days, the last restore
  (stale after `velero.restoreMaxAgeDays`), and namespaces with volumes that
  no schedule covers.
- Feeds the backup posture as the "Velero" source.

## Backup posture (`backups`)

One row per PVC across every backup source. **Page**: `/backups`; **board**:
Backups (*Backup posture*).

- For each PVC: the workload that mounts it, which sources cover it, the last
  good backup and its age against the policy (warn at `backups.warnFactor`
  intervals, crit at `backups.critFactor`), the target and its free space,
  and when a restore was last proven.
- A PVC nothing covers is critical and sorts first, unless `backups.ignore`
  names it or its namespace.
- Restore tests come from source evidence (a Velero restore, a Longhorn
  volume restored from backup) or from a manual mark on the row.
- Target free space comes from a host whose backup folders match the target.
- CSV export: `/api/backups/posture.csv`.
- **Set-up** (admins, deploys on), so Longhorn is driven from here and its own
  web UI is never published:
  - *Backup target*: pick a storage-target connector (NFS export, S3/MinIO
    bucket or SMB share); its credential Secret is written into
    `longhorn-system` from the connector, and Longhorn's own reachability
    verdict and message are shown. While Longhorn can't reach the target,
    every volume it backs up is critical on the posture.
  - *Schedules* per volume group, as Longhorn RecurringJobs: suggested
    `default` (every volume in no other group, including ones created later)
    snapshot hourly keep 24 and back up daily at 03:00 keep 14, and
    `critical` back up every 6 hours keep 28. Each volume's groups can be
    changed from its row.
  - *Back up now* on a volume (a snapshot, then a backup of it).
  - *Restore* from a volume's restore points: to a new claim beside the old
    one (default; the app is untouched), or in place (the workloads that
    mount it scale to zero, the claim is rebound under its own name to the
    restored volume, they scale back up; the old volume is kept until they
    are back and put back if anything fails). Both preview first.
- **This console**: the console's own database volume.
  - On Longhorn it is backed up like any other volume; *Add to the critical
    group* puts it on the 6-hourly schedule.
  - Whatever the storage class, a nightly copy (`deploy.consoleBackup`,
    default `30 3 * * *` UTC, 14 kept) goes to a storage target: the one
    Longhorn backs up to, else the only one. The console writes a consistent
    copy (`VACUUM INTO`) beside its database, and a Job on the same node mounts
    the volume and copies it to `<prefix>console/<release>-<UTC time>.db` on an
    NFS export (mounted by the kubelet) or an S3/MinIO bucket (SigV4 with
    curl). SMB shares need a privileged mount and are refused for this copy.
    *Back up now* runs the same copy at once.
  - *Download recovery kit* (admins; password and authenticator again, or an
    OIDC sign-in from the last 15 minutes; audited) gives `SECRETS_KEY` sealed
    with a passphrase, in a file `openssl enc -d -aes-256-cbc -pbkdf2 -iter
    600000 -md sha256 -a -A` opens. A copy of the database restores without
    it, but every stored secret then reads as missing.
  - The page shows the `install.sh --restore` line for the newest copy
    ([Restoring the console](install.md#restoring-the-console)).

## Fleet (`fleet`)

**Board**: GitOps. Absent when Fleet isn't installed in this cluster (Fleet's
GitRepos live in the cluster that runs Rancher's Fleet manager).

- For each GitRepo: *sync* (the commit it's on) and *deployments*; plus
  standalone bundles.
- ErrApplied, NotReady and SyncFailed are critical, the rest warn
  (`fleet.severity` overrides). NotReady, OutOfSync, WaitApplied and Pending
  are one level milder for `fleet.graceMinutes` while a rollout settles.
- Links go to Rancher's Continuous Delivery pages (`fleet.rancherUrl`), or to
  the commit on the git host.

## Hosts (`hosts`)

NAS and Linux boxes over SSH: Linux, Synology DSM, TrueNAS SCALE, or detected.

- **Pages**: `/hosts` and a host's charts. **Board**: Hosts.
- Checks per host: *SSH*, *load*, *disk space*, *temperature*, *RAID*, *ZFS
  pools*, *SMART* (needs a sudo rule for `smartctl`; unknown with the reason
  without one).
- Only a fixed list of read-only commands is ever run (`/proc`, `df`,
  `sensors`, `smartctl`, `zpool`, `mdstat`); nothing from input reaches the
  shell.
- The host key is pinned on the first successful connection; a changed key
  stops collection with both fingerprints shown.
- Backup folders on a host report their free space to the backup posture.
- Credentials are stored encrypted. Series: `host.cpu.percent`,
  `host.memory.percent`, `host.load`, `host.disk.percent`,
  `host.pool.percent`, `host.temp.celsius`, network rates.

## HTTP and TCP checks (`checks`)

User-defined probes. **Page**: `/checks`; **board**: Checks.

- HTTP: ok on 2xx/3xx unless expected statuses are set, an optional body
  substring, an optional auth header whose value is stored encrypted, and
  certificate expiry (warn below `tlsWarnDays`, crit below a third of it).
- TCP: connects to `host:port`.
- Neither connects to a link-local address (cloud metadata lives there),
  whether the target names one or resolves to one. Loopback, private ranges
  and in-cluster Services are allowed: they are what checks are for. A failed
  body match shows the first 500 characters of the body to everyone who can
  read the board, so point checks at health endpoints, not pages with data.
- Each check has its own interval (15 s to a day) and timeout. The value is the
  latency in ms, so `health.rules` can put thresholds on it. Series:
  `check.latency.ms`.

## Workload browser (`workloads`)

Read-only. **Pages**: `/workloads`, a namespace, a workload, a pod.

- Namespaces, Deployments, StatefulSets, DaemonSets, Jobs and CronJobs with
  their pods and events; pod logs, tailed or followed live.
- Log redaction: `password=`, `token=`, `Bearer …` and similar are always
  masked; the values of the pod's own Secrets are masked too when the opt-in
  Secrets read is granted.
- Links to the same object in Rancher and Headlamp when their URLs are set.
- Check results on the board link here for the pod or workload they're about.

## Setting up and running the cluster

The modules below change the cluster, so they need app deploys turned on
(`install.sh --enable-deploy`, or `deploy.enabled` in the chart). With deploys
off they still show what is installed and the one command that turns deploys
on. Every change is planned first (the objects it creates or changes, and why
not when it can't run), runs as a Job under the installer ServiceAccount, and
is recorded in the audit log.

## App catalog (`catalog`)

The apps the console knows how to install, and what is already in the
cluster. **Page**: Apps → Deploy, Catalog tab.

- Entries: cert-manager, Traefik, metrics-server, Local Path Provisioner,
  Longhorn (headless: no Ingress for its UI; the `longhorn-frontend` Service
  stays for `kubectl port-forward`), Longhorn backups (the backup target),
  Rancher, Headlamp, Gitea, Grafana, Authentik, Pocket ID, Velero, ntfy,
  Cloudflare Tunnel, Tailscale, CloudNativePG, its Barman Cloud plugin and
  the shared Postgres cluster. Each pins a chart version per Kubernetes
  version range and refuses one it doesn't fit. Velero is hidden from the
  picker until it is installed; it can still be deployed over the API and MCP.
- **Discovery** recognises installs by their labels, or by image when the
  labels are missing, whoever installed them, and checks the cluster basics
  (an ingress controller, cert-manager, a default storage class,
  metrics-server), free disk per node and the domain most Ingresses share.
- **The default bundle**: the access tool (Cloudflare Tunnel, Tailscale,
  local network or direct ports), Traefik, cert-manager, metrics-server,
  Local Path Provisioner, Longhorn (optional; it needs open-iscsi on every
  node), a sign-in service at `auth.<domain>` (Authentik by default, or
  Pocket ID: passkeys only, a fraction of the memory, and https required)
  and Gitea at `git.<domain>`. With Authentik ticked the bundle also adds
  CloudNativePG and the shared Postgres cluster ahead of it (and the Barman
  Cloud plugin, optional, for point-in-time recovery to S3 or MinIO).
  Anything already installed or covered by a basic is left out. Headlamp, Grafana and
  ntfy are catalog-only.
- `GET /api/catalog/apps`, `GET /api/catalog/bundles`,
  `GET /api/catalog/discovery`.

## Deploys (`deploy`)

The runner behind every change the console makes. **Pages**: Apps →
Installed and Apps → Deploy; the wizard's Access step.

- **Jobs**: one Kubernetes Job per change, in the console's namespace, running
  `helm` or `kubectl` from a fixed program with its inputs as files, under
  `<release>-installer`. One job per release at a time; logs are kept and
  streamed, with secrets redacted. Bundles run their apps in order and can be
  cancelled between apps.
- **Access**: the mode chosen in the Access step and the base domain decide
  each app's host, Ingress class, certificate issuer and whether the edge
  serves https (`GET/PUT /api/deploy/access`).
- **Sign-in gate**: apps the console publishes sit behind its sign-in through
  a Traefik forwardAuth Middleware, unless switched to **Public** on the
  Installed page. `auth.gate.allow` decides who gets through (admins, or
  everyone who can sign in). Authentik, Pocket ID and ntfy are never gated
  (people sign in through the first two, phones talk to the other); for
  Gitea, Rancher and Grafana a request carrying its own `Authorization` header goes
  straight to the app, so git and API clients keep working. The gate doesn't
  check that header; the app's own login protects those requests, as it
  would with no gate at all. **Board**:
  Access, one check per published app.
- **Upgrade all**: every app the console installed, upgraded in dependency
  order with `helm upgrade --reset-then-reuse-values`, so its values are kept
  and new chart defaults arrive; one app at a time from its row.
- **Failed deploys**: an app whose last install or upgrade failed shows it on
  the Installed page with **Retry** (`helm upgrade --reset-then-reuse-values`
  at the same version, so the values and generated passwords of the failed
  attempt are kept; **Deploy again** when that attempt never created the
  release), **Reinstall** and **Uninstall** (`helm uninstall`, asking every
  time whether its volumes are kept or deleted; Longhorn is never
  uninstalled from here). A failed rollout in the wizard has **Retry and
  continue**, which retries its failed apps and then runs the rest with the
  answers it started with; a failed rollout keeps those answers, sealed,
  until it is resumed or another rollout starts.
- **Actions** on installed apps: raise Longhorn's replica count (Backups
  page), move an app's volumes between local-path and Longhorn under the same
  claim names, whichever way applies (the old volume is kept until the app
  answers on the copy; to Longhorn with an optional download first; to
  local-path with a warning that the data then lives on one node's disk and
  leaves Longhorn's backups), the Backups page's Longhorn set-up, give an app
  a database on the shared Postgres (`pg-database`), set up, run and restore
  its backups (`pg-backups`, `pg-backup-now`, `pg-restore`) and delete a
  cluster a restore replaced (`pg-remove-cluster`), the node actions above,
  the console's own backup, remove a template app or uninstall a catalog app, publish a host directly
  with its own certificate, and open forwarded ports on k3s's Traefik
  (`deploy.forwardedPorts`).
- Defaults for new apps (`deploy.baseDomain`, `deploy.ingressClass`,
  `deploy.clusterIssuer`, `deploy.storageClass`) are empty, meaning what the
  cluster already uses; see [configuration.md](configuration.md#deploys-and-connectors).

## Shared Postgres (`postgres`)

One Postgres cluster, run by CloudNativePG in the `postgres` namespace, for
the apps that need a database. **Board**: Storage (*Shared Postgres*).
Absent until the cluster exists.

- **The cluster**: one instance per node up to two (a replica on a second
  node when there is one), on the default storage class, 10 GiB by default.
  It is labelled `<label domain>/postgres=current`; a restore makes a new
  cluster and moves the label, so the name can change.
- **Per app**: Authentik and Grafana installed while the shared cluster
  exists get their own role and database on it (a `DatabaseRole` and a
  `Database`, kept if the app is removed) and a Secret `<app>-postgres` in
  their namespace with `host`, `port`, `dbname`, `user`, `password` and
  `uri`. Their charts' own Postgres is turned off and they read the
  connection from that Secret. An app already installed with its own
  database keeps it.
- Checks: the cluster's ready instances and phase, and *Postgres
  databases* (each role and database the operator has applied).
- Database size and connection counts come from the primary's metrics
  exporter (port 9187), so the console needs no database credentials.
- **Backups** (Backups page, *Shared Postgres* card): pick a storage target.
  An S3 or MinIO bucket gets point-in-time recovery: the Barman Cloud plugin
  archives every WAL segment to `<bucket>/<prefix>/postgres/` and takes base
  backups on a schedule (default `0 2 * * *`, 14 days kept). Turning it on
  restarts each instance once. NFS and SMB can't take a WAL archive, so they
  get dumps instead: a CronJob runs `pg_dumpall` onto a Longhorn volume in
  the "critical" group (14 dumps kept), which Longhorn backs up to its own
  target; that target must be the one picked. The cluster's volumes then
  count as protected in the backup posture.
- **Restore** never touches the cluster in use: a new cluster is recovered
  to the chosen moment (or initialised and loaded from the chosen dump),
  each app gets its role and database there with a new password, its Secret
  is pointed at it and the app restarts, backups move to the new cluster,
  and the old one is labelled `previous`, hibernated and kept until it is
  deleted from the card.
- `GET /api/postgres/cluster`, `GET /api/postgres/databases`,
  `GET|PUT /api/postgres/backups`, `POST /api/postgres/backups/now`,
  `POST /api/postgres/restore/plan`, `POST /api/postgres/restore`; the MCP
  tools `list_databases`, `get_postgres_backups`, `set_postgres_backups`,
  `backup_postgres_now`, `plan_postgres_restore` and `restore_postgres`.

## Templates (`templates`)

Small apps and your own containers. **Page**: Apps → Deploy, tabs
"Templates and custom apps" and "External services".

- Library: whoami, Uptime Kuma, IT-Tools, and **Custom app** (any image with
  a tag or digest, its port, environment variables and an optional
  volume). Each instance is remembered, upgraded from the Installed page to the library's current pin,
  and can be removed with or without its volumes.
- **External services**: a machine outside the cluster (a NAS, a game
  server) published through Traefik: http and https through an Ingress, tcp
  and udp on a forwarded port.
- An HTTP check is added for each instance's address.
- **Guardrail**: a template can't ask for host paths, host networking,
  privileged containers, added capabilities beyond Pod Security "baseline",
  or RBAC; everything rendered is checked again before it runs, and the
  chart's ValidatingAdmissionPolicies hold the same line in the cluster for
  namespaces labelled as template namespaces.

## Connectors (`connectors`)

The framework for services the console manages outside the cluster.
**Page**: Admin → Connectors.

- Each connector kind declares its fields (secrets stored encrypted, never
  shown again), a test, and a reconcile that brings the service in line and
  records what it owns, so cleanup removes only that.
- **Board**: Access and Identity, one check per connector, with the last
  reconcile's result.
- `GET /api/connectors/kinds`, `GET/POST /api/connectors`,
  `POST /api/connectors/<id>/test`, `POST /api/connectors/<id>/reconcile`.

## Cloudflare (`connector-cloudflare`)

**Page**: Admin → Cloudflare, also reached from the Access step's "Connect
with an API token".

- Creates a tunnel (or adopts an existing one by name), runs cloudflared in
  the cluster, and keeps one tunnel route and one DNS record per published
  host. A wildcard record pointing the zone at another tunnel is warned about.
- **Direct** hosts get a DNS-only record at the public address (the
  connector's field, or looked up through `connector-cloudflare.addressLookup`
  and re-checked every few minutes) and their own certificate.
- **Cloudflare Access** apps are optional:
  `connector-cloudflare.accessApps` is `never` (default), `always` or
  `per-app`, with an allow list of emails and `@domains`. The console's own
  sign-in gate covers apps either way.
- Token permissions: Cloudflare Tunnel Edit, Zone Read, DNS Edit, and Access:
  Apps and Policies Edit when Access is used. A missing one is named in the
  error.

## Microsoft Entra ID (`connector-entra`)

**Page**: Admin → Connectors.

- Needs a management app registration with Microsoft Graph's
  `Application.ReadWrite.OwnedBy` application permission, admin consented
  (`Group.Read.All` too, to pick admin groups by name). Save its tenant ID,
  client ID, object ID (from its Overview page) and a client secret.
- **Sign-in**: it creates the console's sign-in app registration (redirect
  URI from the public URL, which must be https), gives it a certificate
  whose private key never leaves the console, and points OIDC sign-in at it.
  Sign-in authenticates to Entra with a signed client assertion
  (`private_key_jwt`), so the sign-in app has no client secret. The
  certificate is replaced 30 days before it expires; the old one is removed
  on the next sync. A tenant that refuses certificates gets a client secret
  instead, rotated the same way, and moves to a certificate once it accepts
  one. Sign-in apps set up before certificates move on the first sync.
- **The connector's own credential**: the client secret you paste is only
  for getting started. The console makes a certificate for the management
  app and gets it onto the app:
  - If the management app may write itself (it is an owner of itself, or
    holds `Application.ReadWrite.All`), the console uploads the certificate,
    switches to it and deletes the secret in Entra, all within two syncs.
  - With `Application.ReadWrite.OwnedBy` alone it can't, so the connector's
    "Connector credential" check (and the Sign-in step) asks you to upload
    the certificate once: download it from the check's link
    (`GET /api/connector-entra/certificate`, PEM, public material only) and
    add it under the management app's Certificates & secrets. On the next
    sync the console signs in with it and asks you to delete the client
    secret there; once Entra refuses the secret, the console forgets it too.
  - From then on it replaces its own certificate 30 days before expiry with
    Graph's `addKey` / `removeKey`, which an app may call on itself with no
    permission, proving it holds the current key. That needs the object ID:
    the field above, or read from Graph when the app may read itself.
  - A secret saved on the connector later still works: the console falls
    back to it whenever the certificate is refused.
- Lists security groups by name for `auth.oidc.adminGroups` (needs
  `Group.Read.All`).
- Microsoft 365 email (Notifications) sends with the same credential.

## Storage targets (`connector-storage`)

**Page**: Admin → Connectors → Storage target. Any number of them.

- A place backups go: an NFS export (`nfs://server:/export`), an S3 or
  MinIO bucket (`s3://bucket@region/`, with an endpoint for MinIO and an
  access key) or an SMB/CIFS share (`cifs://server/share`, with a user and
  password). An optional path prefix puts this cluster's backups in a folder
  under it. "Pick a host" fills the server in from a machine under Hosts.
- Test and the scheduled health check run from the console's pod: a TCP
  connection to port 2049 (NFS), 445 (SMB) or the S3 endpoint, and for S3 a
  signed bucket listing that proves the keys can read it. Mounting needs
  privileges the console doesn't have, so for NFS and SMB the proof is
  Longhorn's own: once Longhorn's backup target points at the storage
  target, its availability (and Longhorn's error, verbatim, when it can't
  mount) shows as a "Longhorn" check on the connector.
- Credentials stay sealed in the console. The Backups page's set-up hands
  Longhorn a Secret with them (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
  / `AWS_ENDPOINTS`, or `CIFS_USERNAME` / `CIFS_PASSWORD`) in
  `longhorn-system`; no route ever returns them.
- Longhorn mounts the target from each node: the installer puts the NFS
  client there, and SMB targets also need `cifs-utils` on every node.

## MCP server (`mcp`)

Serves `/mcp` for Claude and other MCP clients, with API tokens or OAuth.
Tools mirror the REST API and run as the token's owner, capped by its scope.
`mcp.requestsPerMinute` (120) limits each token. See [mcp.md](mcp.md).

## Publish (`publish`)

Reserved for the full publish flow on the [roadmap](roadmap.md#later); it
registers nothing yet. Publishing the apps the console deploys is done today
by the deploy and Cloudflare modules.

## First run (`onboarding`)

The setup wizard. **Page**: Admin → Setup (`/welcome`). It opens by itself
for an admin after sign-in until it is finished.

- Steps: Password (done by the forced change, with the public URL), Cluster,
  Access (how you reach your apps, or the default bundle), Sign-in, Links,
  Hosts, Checks, Alerts, Findings. All but the last can be skipped; each
  stays editable afterwards.
- Findings counts nodes not Ready, PVCs no backup source covers, and volumes
  whose last backup attempt failed.
- `GET /api/onboarding/state`; `POST /api/onboarding/steps/<step>` with
  `{"action": "done" | "skip"}` (admins, audited).
