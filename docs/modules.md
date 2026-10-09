# Modules

Each part of the console is a module: it reads something, judges it, and
reports into the shared health board, metrics store or backup posture. This
page says what each one watches, where it shows up, and what it needs.
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

Sends health changes to **ntfy**, **Discord** or a **webhook** (a JSON POST).

- **Page**: Admin → Notifications. Each channel has a minimum severity (warn
  or crit) and a test button. A recovery is sent only to channels that were
  told about the problem.
- A change is held for `notify.debounceSeconds` (90) and dropped if it flaps
  back; a check that keeps flapping is sent with its current status after
  `notify.maxHoldSeconds` (900). Failed deliveries retry three times.
- Channel URLs and tokens are stored encrypted and never shown again.

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

## First run (`onboarding`)

The setup wizard. **Page**: Admin → Setup (`/welcome`). It opens by itself
for an admin after sign-in until it is finished.

- Steps: Password (done by the forced change), Cluster, Sign-in, Links,
  Hosts, Checks, Alerts, Findings. All but the last can be skipped; each
  stays editable afterwards.
- Findings counts nodes not Ready, PVCs no backup source covers, and volumes
  whose last backup attempt failed.
- `GET /api/onboarding/state`; `POST /api/onboarding/steps/<step>` with
  `{"action": "done" | "skip"}` (admins, audited).
