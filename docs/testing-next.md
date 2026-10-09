# Testing a next build

Work for the next release lands on the `next` branch first. Every push there
publishes:

- the image as `ghcr.io/<owner>/<imageName>:next` and `:next.<run>`;
- the chart as `<version>-next.<run>` (for example `0.2.0-next.14`) at
  `oci://ghcr.io/<owner>/charts-next/<chartName>`.

The chart path is separate from main's `charts/` on purpose: the plain
installer takes the newest edge build from `charts/` and never sees a next
build. `next` is merged to `main` once a next build has checked out on a real
install. This page is how to run that check.

## A test machine

Use a VM you can throw away, not the cluster you rely on. 2 vCPU, 4 GB of
memory and 30 GB of disk run the console and the default bundle on one node;
add a second node to try Longhorn replicas, join links and node actions.
Take a hypervisor snapshot before the first install, so going back to a clean
machine takes a minute.

Keep the real names of your machines, domains and addresses in
`docs/<anything>.local.md`, which git ignores, rather than in a committed file.

## Install

On the VM, as root (or with sudo):

```
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/install.sh | sh -s -- --channel next --enable-deploy
```

The scripts come from `main`; `--channel next` is what picks the build. With
no cluster on the machine the installer brings up a single-node k3s first.
The console is then at `http://<vm address>:32450/` and the installer prints
the first admin password. `--version 0.2.0-next.14` installs one build in
particular instead of the newest.

## Update to the newest next build

```
curl -sfL https://raw.githubusercontent.com/dihoyt/project-fairlead/main/update.sh | sh -s -- --channel next
```

`update.sh` keeps the release's settings (port, host, origin, app deploys)
and prints the chart and image before and after. The build a pod is running
is in `/healthz` (`{"status":"ok","version":"<commit>"}`) and in
`helm -n <namespace> list`.

Apps the console installed are upgraded separately, from **Apps → Installed →
Upgrade all**, when a build changes their pinned versions.

### Changes to notice on upgrade

- **Longhorn's web UI is no longer published.** Its recipe now turns the
  chart's Ingress off and adds no Cloudflare route, so on the next **Upgrade
  all** an install that published `longhorn-frontend` loses that address. The
  Service stays, so `kubectl -n longhorn-system port-forward
  svc/longhorn-frontend 8000:80` still reaches it. Backup target, schedules,
  backup now and restore are on the **Backups** page instead.
- **Velero is hidden from the catalog picker.** An install that has it keeps
  it on the Installed page, and it can still be deployed over the API and MCP.

## Roll back

- **To an earlier next build**: `update.sh --channel next --version <older
  version>`, or `helm -n <namespace> rollback <release>` to the previous
  revision. Migrations are additive and a pod leaves alone any it doesn't
  know, so an older build runs on a database a newer one has touched.
- **Back to main's builds**: `update.sh` without `--channel next` moves to
  the newest edge build. A next build can carry migrations that main numbers
  differently by the time it lands, so treat this as a reinstall: restore the
  VM snapshot, or `install.sh --uninstall --purge` and install again.
- **The cluster itself**: apps the console installed stay installed on any of
  these; remove them from the Installed page first if the test needs a clean
  cluster, or restore the snapshot.

## What to look at

- The board after a fresh install, before the wizard: nothing should be red
  that isn't really broken.
- The wizard end to end, with the default bundle and the access tool you use.
- Whatever the round changed: the round's pull requests into `next` say what
  each one does.
- The pod's log (`kubectl -n <namespace> logs deploy/<release>`) and the
  Jobs the console ran (`kubectl -n <namespace> get jobs`), when something
  looks wrong.
