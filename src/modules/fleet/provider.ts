import { RESOURCES } from "../../contracts/k8s.js";
import type { K8sApi, KubeObject } from "../../contracts/k8s.js";
import type { CheckResult, HealthProvider, Status } from "../../contracts/health.js";
import { DEFAULT_SEVERITY, STATES, TRANSITIONAL, type FleetState, type Severity } from "./settings.js";

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastUpdateTime?: string;
  lastTransitionTime?: string;
}

interface ModifiedResource {
  apiVersion?: string;
  kind?: string;
  namespace?: string;
  name?: string;
  missing?: boolean;
  delete?: boolean;
  patch?: string;
}

interface NonReadyResource {
  name?: string;
  bundleState?: string;
  state?: string;
  message?: string;
  modifiedStatus?: ModifiedResource[];
}

interface Summary {
  desiredReady?: number;
  ready?: number;
  notReady?: number;
  modified?: number;
  errApplied?: number;
  outOfSync?: number;
  waitApplied?: number;
  pending?: number;
  nonReadyResources?: NonReadyResource[];
}

export interface GitRepo extends KubeObject {
  spec?: { repo?: string; branch?: string; revision?: string; paths?: string[]; paused?: boolean };
  status?: {
    commit?: string;
    desiredReadyClusters?: number;
    readyClusters?: number;
    gitJobStatus?: string;
    display?: { state?: string; message?: string; error?: boolean; readyBundleDeployments?: string };
    summary?: Summary;
    conditions?: Condition[];
  };
}

export interface Bundle extends KubeObject {
  status?: {
    display?: { state?: string; readyClusters?: string };
    summary?: Summary;
    conditions?: Condition[];
  };
}

export interface JudgeOptions {
  now: Date;
  graceMs: number;
  severity: Partial<Record<FleetState, Severity>>;
  rancherUrl: string;
}

const REPO_LABEL = "fleet.cattle.io/repo-name";
const COMMIT_LABEL = "fleet.cattle.io/commit";

// Worst first, so the first state with a count names the deployment's state.
const COUNTED: Array<[FleetState, keyof Summary]> = [
  ["ErrApplied", "errApplied"],
  ["NotReady", "notReady"],
  ["Modified", "modified"],
  ["OutOfSync", "outOfSync"],
  ["WaitApplied", "waitApplied"],
  ["Pending", "pending"],
];

const ORDER: Status[] = ["crit", "warn", "ok"];
const worse = (a: Status, b: Status) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);
const milder = (s: Severity): Severity => (s === "crit" ? "warn" : "ok");
const short = (sha: string | undefined) => (sha ? sha.slice(0, 7) : undefined);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const key = (obj: KubeObject) => `${obj.metadata.namespace ?? ""}/${obj.metadata.name}`;

const trim = (path: string) => path.replace(/\/+$/, "").replace(/\.git$/, "");

// The web page of a git remote, credentials dropped: https as given, scp-style
// and ssh:// remotes mapped to https on the same host.
export function repoWebUrl(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(remote);
  if (scp && !/^https?:/i.test(remote)) return `https://${scp[1]}/${trim(scp[2]!).replace(/^\/+/, "")}`;
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return undefined;
  }
  if (url.protocol === "ssh:" || url.protocol === "git:") return `https://${url.hostname}${trim(url.pathname)}`;
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return `${url.protocol}//${url.host}${trim(url.pathname)}`;
}

export function commitUrl(remote: string | undefined, sha: string | undefined): string | undefined {
  const web = repoWebUrl(remote);
  return web && sha ? `${web}/commit/${sha}` : web;
}

export function rancherUrl(base: string, kind: "gitrepo" | "bundle", obj: KubeObject): string | undefined {
  if (!base) return undefined;
  const ns = encodeURIComponent(obj.metadata.namespace ?? "");
  const name = encodeURIComponent(obj.metadata.name);
  return `${base.replace(/\/+$/, "")}/dashboard/c/_/fleet/fleet.cattle.io.${kind}/${ns}/${name}`;
}

function condition(conditions: Condition[] | undefined, type: string): Condition | undefined {
  return conditions?.find((c) => c.type === type);
}

// The remote as shown to a person: never with its userinfo.
function safeRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remote.replace(/^[^@/\s]+@/, "");
  }
}

export function driftOf(summaries: Array<Summary | undefined>): ModifiedResource[] {
  const seen = new Map<string, ModifiedResource>();
  for (const summary of summaries) {
    for (const resource of summary?.nonReadyResources ?? []) {
      for (const m of resource.modifiedStatus ?? []) {
        seen.set(`${m.apiVersion}/${m.kind}/${m.namespace ?? ""}/${m.name}`, m);
      }
    }
  }
  return [...seen.values()];
}

function describeDrift(drift: ModifiedResource[]): string {
  const how = (m: ModifiedResource) => (m.missing ? "missing" : m.delete ? "extra" : "modified");
  const names = drift.slice(0, 3).map((m) => `${m.kind} ${m.namespace ? `${m.namespace}/` : ""}${m.name} ${how(m)}`);
  return names.join(", ") + (drift.length > 3 ? ` (+${drift.length - 3} more)` : "");
}

function judgeState(state: FleetState, since: string | undefined, opts: JudgeOptions): Severity {
  const configured = opts.severity[state] ?? DEFAULT_SEVERITY[state];
  if (!TRANSITIONAL.has(state)) return configured;
  const changed = since ? Date.parse(since) : Number.NaN;
  const young = Number.isFinite(changed) && opts.now.getTime() - changed < opts.graceMs;
  return young ? milder(configured) : configured;
}

function stateOf(summary: Summary | undefined, display: string | undefined): FleetState[] {
  const counted = COUNTED.filter(([, field]) => ((summary?.[field] as number | undefined) ?? 0) > 0).map(([s]) => s);
  if (counted.length) return counted;
  return STATES.includes(display as FleetState) ? [display as FleetState] : [];
}

function readyChanged(conditions: Condition[] | undefined): string | undefined {
  const ready = condition(conditions, "Ready");
  return ready?.lastTransitionTime ?? ready?.lastUpdateTime;
}

export function judgeSync(repo: GitRepo, opts: JudgeOptions): CheckResult {
  const { metadata, spec = {}, status = {} } = repo;
  const observedAt = opts.now.toISOString();
  const commit = status.commit;
  const where = spec.revision ? `revision ${spec.revision}` : `branch ${spec.branch ?? "master"}`;
  const stalled = condition(status.conditions, "Stalled");
  const polling = condition(status.conditions, "GitPolling");
  const accepted = condition(status.conditions, "Accepted");
  const base = {
    id: `gitrepo/${key(repo)}/sync`,
    label: `${metadata.name} sync`,
    ...(short(commit) ? { value: short(commit) } : {}),
    deepLink: commitUrl(spec.repo, commit) ?? rancherUrl(opts.rancherUrl, "gitrepo", repo),
    observedAt,
  };
  const raw = {
    gitRepo: key(repo),
    repo: safeRemote(spec.repo),
    branch: spec.branch,
    revision: spec.revision,
    commit,
    gitJobStatus: status.gitJobStatus,
    conditions: status.conditions,
  };

  const failure =
    (stalled?.status === "True" && (stalled.message || "Stalled")) ||
    (polling?.status === "False" && (polling.message || "Git polling failed")) ||
    (accepted?.status === "False" && (accepted.message || "Not accepted")) ||
    (status.gitJobStatus === "Failed" && "Git job failed");
  if (failure) {
    return {
      ...base,
      status: judgeState("SyncFailed", undefined, opts),
      detail: `Cannot sync ${where}: ${failure}${commit ? ` (last commit ${short(commit)})` : ""}`,
      raw,
    };
  }
  if (spec.paused) {
    const s = judgeState("Paused", undefined, opts);
    return {
      ...base,
      status: s,
      detail: `Paused at ${short(commit) ?? "no commit"} on ${where}`,
      ...(s === "ok" ? {} : { raw }),
    };
  }
  if (!commit) {
    const s = judgeState("Pending", metadata.creationTimestamp, opts);
    return {
      ...base,
      status: s,
      detail: `No commit fetched yet from ${where}`,
      ...(s === "ok" ? {} : { raw }),
    };
  }
  return { ...base, status: "ok", detail: `At ${short(commit)} on ${where}` };
}

export function judgeDeploy(repo: GitRepo, bundles: Bundle[], opts: JudgeOptions): CheckResult {
  const { metadata, spec = {}, status = {} } = repo;
  const summary = status.summary;
  const states = stateOf(summary, status.display?.state);
  const since = readyChanged(status.conditions);
  const drift = driftOf([summary, ...bundles.map((b) => b.status?.summary)]);
  const stale = bundles.filter(
    (b) =>
      status.commit && b.metadata.labels?.[COMMIT_LABEL] && !status.commit.startsWith(b.metadata.labels[COMMIT_LABEL]!)
  );

  let result: Status = "ok";
  for (const state of states) result = worse(result, judgeState(state, since, opts));

  const ready = summary?.ready ?? 0;
  const desired = summary?.desiredReady ?? 0;
  const counts = COUNTED.map(([state, field]) => [state, (summary?.[field] as number | undefined) ?? 0] as const)
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${n} ${state}`);
  const clusters =
    status.desiredReadyClusters !== undefined
      ? `, ${status.readyClusters ?? 0}/${status.desiredReadyClusters} clusters`
      : "";
  const head = `${ready}/${desired} bundle deployments ready${clusters}`;
  const notReady = bundles.filter((b) => (b.status?.display?.state ?? "Ready") !== "Ready").map((b) => b.metadata.name);

  const parts = [head];
  if (counts.length) parts.push(counts.join(", "));
  if (drift.length) parts.push(`drift: ${describeDrift(drift)}`);
  else if (notReady.length)
    parts.push(`bundles: ${notReady.slice(0, 3).join(", ")}${notReady.length > 3 ? ", …" : ""}`);
  const why = status.display?.message || condition(status.conditions, "Ready")?.message;
  if (result !== "ok" && why && !drift.length) parts.push(why);
  if (result === "ok" && states.length) parts.push("rolling out");

  return {
    id: `gitrepo/${key(repo)}/deploy`,
    label: `${metadata.name} deployments`,
    status: result,
    value: desired - ready,
    detail: parts.join("; "),
    ...(result === "ok"
      ? {}
      : {
          raw: {
            gitRepo: key(repo),
            commit: status.commit,
            display: status.display,
            summary,
            drift,
            bundles: bundles.map((b) => ({
              name: b.metadata.name,
              commit: b.metadata.labels?.[COMMIT_LABEL],
              display: b.status?.display,
              summary: b.status?.summary,
            })),
            ...(stale.length ? { bundlesOnOlderCommit: stale.map((b) => b.metadata.name) } : {}),
          },
        }),
    deepLink: rancherUrl(opts.rancherUrl, "gitrepo", repo) ?? commitUrl(spec.repo, status.commit),
    observedAt: opts.now.toISOString(),
  };
}

// Bundles that no GitRepo owns (Fleet's own agent bundles, bundles applied
// directly): one check for all of them, so they are seen without a check per
// object.
export function judgeStandalone(bundles: Bundle[], opts: JudgeOptions): CheckResult | undefined {
  if (!bundles.length) return undefined;
  let result: Status = "ok";
  const bad: Array<{ bundle: Bundle; state: FleetState | undefined }> = [];
  for (const bundle of bundles) {
    const states = stateOf(bundle.status?.summary, bundle.status?.display?.state);
    let s: Status = "ok";
    for (const state of states) s = worse(s, judgeState(state, readyChanged(bundle.status?.conditions), opts));
    if (s !== "ok") bad.push({ bundle, state: states[0] });
    result = worse(result, s);
  }
  const drift = driftOf(bundles.map((b) => b.status?.summary));
  const names = bad.slice(0, 3).map(({ bundle, state }) => `${key(bundle)} ${state}`);
  const detail =
    `${bundles.length - bad.length}/${plural(bundles.length, "standalone bundle")} ready` +
    (bad.length ? `; ${names.join(", ")}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ""}` : "") +
    (drift.length ? `; drift: ${describeDrift(drift)}` : "");
  const link = bad[0] ? rancherUrl(opts.rancherUrl, "bundle", bad[0].bundle) : undefined;
  return {
    id: "bundles",
    label: "Standalone bundles",
    status: result,
    value: bad.length,
    detail,
    ...(bad.length
      ? {
          raw: bad.map(({ bundle }) => ({
            bundle: key(bundle),
            display: bundle.status?.display,
            summary: bundle.status?.summary,
          })),
        }
      : {}),
    ...(link ? { deepLink: link } : {}),
    observedAt: opts.now.toISOString(),
  };
}

export function judgeAll(repos: GitRepo[], bundles: Bundle[], opts: JudgeOptions): CheckResult[] {
  const owned = new Set<Bundle>();
  const results: CheckResult[] = [];
  const sorted = repos.toSorted((a, b) => key(a).localeCompare(key(b)));
  for (const repo of sorted) {
    const mine = bundles.filter(
      (b) => b.metadata.namespace === repo.metadata.namespace && b.metadata.labels?.[REPO_LABEL] === repo.metadata.name
    );
    for (const b of mine) owned.add(b);
    results.push(judgeSync(repo, opts), judgeDeploy(repo, mine, opts));
  }
  const standalone = judgeStandalone(
    bundles.filter((b) => !owned.has(b)).toSorted((a, b) => key(a).localeCompare(key(b))),
    opts
  );
  if (standalone) results.push(standalone);
  return results;
}

export interface ProviderDeps {
  k8s(): K8sApi;
  options(): Omit<JudgeOptions, "now">;
  now?: () => Date;
}

export function fleetHealthProvider(deps: ProviderDeps): HealthProvider {
  const now = deps.now ?? (() => new Date());
  return {
    id: "fleet",
    category: "gitops",
    label: "Fleet",
    intervalMs: 60_000,
    async collect(): Promise<CheckResult[]> {
      const at = now();
      const observedAt = at.toISOString();
      let repos: GitRepo[] | "absent";
      let bundles: Bundle[] | "absent";
      try {
        const k8s = deps.k8s();
        [repos, bundles] = await Promise.all([
          k8s.list<GitRepo>(RESOURCES.fleetGitRepos),
          k8s.list<Bundle>(RESOURCES.fleetBundles),
        ]);
      } catch (err) {
        return [
          {
            id: "fleet",
            label: "Fleet",
            status: "unknown",
            detail: `Cannot read Fleet objects: ${message(err)}`,
            raw: { error: message(err) },
            observedAt,
          },
        ];
      }
      if (repos === "absent") {
        return [{ id: "fleet", label: "Fleet", status: "absent", detail: "Fleet is not installed", observedAt }];
      }
      const results = judgeAll(repos, bundles === "absent" ? [] : bundles, { ...deps.options(), now: at });
      if (!results.length) {
        return [{ id: "fleet", label: "Fleet", status: "ok", detail: "Fleet is installed; no GitRepos", observedAt }];
      }
      return results;
    },
  };
}
