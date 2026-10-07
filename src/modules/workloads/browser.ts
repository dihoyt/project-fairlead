import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import type { EventView, NamespaceView, PodView, WorkloadKind, WorkloadView } from "../../contracts/workloads.js";
import { HttpError } from "../../runtime/http.js";
import { ObjectCache } from "./cache.js";
import {
  WORKLOAD_KINDS,
  eventView,
  intermediates,
  isWorkloadKind,
  namespaceView,
  podView,
  topOwner,
  workloadView,
  type Intermediates,
  type KubeEvent,
  type Pod,
  type Workload,
} from "./views.js";

const KIND_REFS = {
  Deployment: RESOURCES.deployments,
  StatefulSet: RESOURCES.statefulSets,
  DaemonSet: RESOURCES.daemonSets,
  Job: RESOURCES.jobs,
  CronJob: RESOURCES.cronJobs,
} as const satisfies Record<WorkloadKind, (typeof RESOURCES)[keyof typeof RESOURCES]>;

export const EVENT_LIMIT = 500;

const order = (kind: WorkloadKind) => WORKLOAD_KINDS.indexOf(kind);
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

// Reads for the workload browser, all served from shared watches.
export class Browser {
  readonly cache: ObjectCache;
  private readonly k8s: () => K8sApi;

  constructor(k8s: () => K8sApi, cache = new ObjectCache({ k8s })) {
    this.k8s = k8s;
    this.cache = cache;
  }

  private async through(): Promise<Intermediates> {
    const [replicaSets, jobs] = await Promise.all([
      this.cache.list(RESOURCES.replicaSets),
      this.cache.list(RESOURCES.jobs),
    ]);
    return intermediates(replicaSets, jobs);
  }

  private async allPods(through: Intermediates): Promise<PodView[]> {
    return (await this.cache.list<Pod>(RESOURCES.pods)).map((pod) => podView(pod, through));
  }

  // Jobs a CronJob started are shown under the CronJob, not beside it.
  private async allWorkloads(): Promise<WorkloadView[]> {
    const k8s = this.k8s();
    const lists = await Promise.all(
      WORKLOAD_KINDS.map(async (kind) => {
        const items = await this.cache.list<Workload>(KIND_REFS[kind]);
        return items
          .filter((obj) => !(kind === "Job" && topOwner(obj, new Map())?.startsWith("CronJob/")))
          .map((obj) => workloadView(obj, kind, k8s.managedBy(obj)));
      })
    );
    return lists.flat();
  }

  async namespace(name: string): Promise<KubeObject> {
    const found = (await this.cache.list(RESOURCES.namespaces)).find((ns) => ns.metadata.name === name);
    if (!found) throw new HttpError(404, `Space "${name}" not found.`);
    return found;
  }

  async namespaces(): Promise<NamespaceView[]> {
    const [namespaces, workloads, through] = await Promise.all([
      this.cache.list(RESOURCES.namespaces),
      this.allWorkloads(),
      this.through(),
    ]);
    const pods = await this.allPods(through);
    const k8s = this.k8s();
    return namespaces
      .map((ns) =>
        namespaceView(
          ns,
          workloads.filter((w) => w.namespace === ns.metadata.name).length,
          pods.filter((p) => p.namespace === ns.metadata.name),
          k8s.managedBy(ns)
        )
      )
      .toSorted(byName);
  }

  async workloads(namespace: string): Promise<WorkloadView[]> {
    await this.namespace(namespace);
    return (await this.allWorkloads())
      .filter((w) => w.namespace === namespace)
      .toSorted((a, b) => order(a.kind) - order(b.kind) || byName(a, b));
  }

  async pods(namespace: string, workload?: string): Promise<PodView[]> {
    await this.namespace(namespace);
    const through = await this.through();
    return (await this.allPods(through))
      .filter((p) => p.namespace === namespace && (!workload || p.owner === workload))
      .toSorted(byName);
  }

  async rawPod(namespace: string, name: string): Promise<Pod> {
    const found = (await this.cache.list<Pod>(RESOURCES.pods)).find(
      (pod) => pod.metadata.namespace === namespace && pod.metadata.name === name
    );
    if (!found) throw new HttpError(404, `Pod "${name}" not found in ${namespace}.`);
    return found;
  }

  async pod(namespace: string, name: string): Promise<PodView> {
    const pod = await this.rawPod(namespace, name);
    return podView(pod, await this.through());
  }

  // `object` is "Kind/name". For a workload it also takes in the events of
  // the pods, ReplicaSets and Jobs it owns, which is where a failing
  // workload's story actually is.
  async events(namespace: string, object?: string): Promise<EventView[]> {
    await this.namespace(namespace);
    const events = (await this.cache.list<KubeEvent>(RESOURCES.events)).filter(
      (e) => (e.involvedObject?.namespace ?? e.metadata.namespace) === namespace
    );
    let wanted: Set<string> | undefined;
    if (object) {
      wanted = new Set([object]);
      const kind = object.slice(0, object.indexOf("/"));
      if (isWorkloadKind(kind)) {
        const through = await this.through();
        for (const [key, owner] of through) {
          const [ns, intermediateKind, name] = key.split("/");
          if (ns === namespace && owner === object) wanted.add(`${intermediateKind}/${name}`);
        }
        for (const pod of await this.allPods(through)) {
          if (pod.namespace === namespace && pod.owner === object) wanted.add(`Pod/${pod.name}`);
        }
      }
    }
    return events
      .map(eventView)
      .filter((e) => !wanted || wanted.has(e.object))
      .toSorted((a, b) => (Date.parse(b.lastSeen) || 0) - (Date.parse(a.lastSeen) || 0))
      .slice(0, EVENT_LIMIT);
  }
}
