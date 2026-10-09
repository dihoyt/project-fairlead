import type {
  DeployActionPlan,
  DeployActionStep,
  DrainPod,
  NodeActionRequest,
  NodeDrainOptions,
  PlannedObject,
} from "../../../contracts/deploy.js";
import { deployedLabel } from "../../../contracts/deployed.js";
import { RESOURCES, type KubeObject, type ResourceRef } from "../../../contracts/k8s.js";
import { product } from "../../../product.js";
import { VALUES_DIR } from "../apps.js";
import { display } from "../plan.js";
import type { ActionContext, ActionRecipe, ActionRendered } from "./index.js";

export const NODE_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
export const DRAIN_TIMEOUT_DEFAULT = 300;
// How long a rebooted node has to come back Ready.
export const REBOOT_WAIT_SECONDS = 900;
// Where the reboot pod runs: privileged pods are admitted there under every
// common Pod Security setup.
export const REBOOT_NAMESPACE = "kube-system";
const MIRROR_ANNOTATION = "kubernetes.io/config.mirror";
const CONTROL_PLANE_LABELS = ["node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master"];

// Not in RESOURCES: older charts don't grant the read, so a 403 just means
// no PodDisruptionBudget rows in the plan.
export const PDBS: ResourceRef = {
  group: "policy",
  version: "v1",
  plural: "poddisruptionbudgets",
  kind: "PodDisruptionBudget",
  namespaced: true,
};

// Cordons and evicts through kubectl drain (the eviction API, so
// PodDisruptionBudgets hold). When it stops, the budgets that allow no
// disruption are named, since kubectl's own retry lines don't.
const DRAIN_FN = `drain() {
  set -- --ignore-daemonsets="$(cat ${VALUES_DIR}/ignore-daemonsets)" --delete-emptydir-data="$(cat ${VALUES_DIR}/delete-emptydir-data)" --timeout="$(cat ${VALUES_DIR}/timeout)s"
  if ! kubectl drain "$node" "$@"; then
    blocked=$(kubectl get poddisruptionbudgets --all-namespaces -o json | jq -r '.items[] | select((.status.disruptionsAllowed // 0) == 0) | "  \\(.metadata.namespace)/\\(.metadata.name)"' || true)
    if [ -n "$blocked" ]; then
      echo "PodDisruptionBudgets that allow no eviction right now:"
      echo "$blocked"
    fi
    echo "Error: $node is cordoned but not drained; uncordon it, or fix what stopped it and drain again."
    exit 1
  fi
}
`;

export const DRAIN_SCRIPT = `set -eu
node=$(cat ${VALUES_DIR}/node)
${DRAIN_FN}drain
echo "$node is drained and stays cordoned; uncordon it to take pods again."
`;

// Drain, then a privileged pod pinned to the node runs systemctl reboot in
// the host's namespaces. Back up means a new boot ID (or, where the kubelet
// reports none, NotReady then Ready) and Ready, within the wait.
export const REBOOT_SCRIPT = `set -eu
node=$(cat ${VALUES_DIR}/node)
pod=$(cat ${VALUES_DIR}/pod-name)
wait_s=$(cat ${VALUES_DIR}/reboot-wait)
${DRAIN_FN}boot=$(kubectl get node "$node" -o jsonpath='{.status.nodeInfo.bootID}')
drain
echo "Rebooting $node"
kubectl delete pod "$pod" --namespace ${REBOOT_NAMESPACE} --ignore-not-found --wait=true
kubectl create -f ${VALUES_DIR}/reboot-pod.json
deadline=$(( $(date +%s) + wait_s ))
down=no
while :; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Error: $node did not come back Ready within $(( wait_s / 60 )) minutes; it stays cordoned."
    exit 1
  fi
  info=$(kubectl get node "$node" -o jsonpath='{.status.nodeInfo.bootID} {.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
  id=\${info% *}
  ready=\${info##* }
  if [ "$down" = no ]; then
    if [ "$ready" != True ] || { [ -n "$boot" ] && [ -n "$id" ] && [ "$id" != "$boot" ]; }; then
      echo "$node went down."
      down=yes
    elif [ "$(kubectl get pod "$pod" --namespace ${REBOOT_NAMESPACE} -o jsonpath='{.status.phase}' 2>/dev/null || true)" = Failed ]; then
      kubectl logs "$pod" --namespace ${REBOOT_NAMESPACE} 2>/dev/null || true
      kubectl delete pod "$pod" --namespace ${REBOOT_NAMESPACE} --ignore-not-found
      echo "Error: the reboot command failed on $node; it was not rebooted and stays cordoned."
      exit 1
    fi
  fi
  if [ "$down" = yes ] && [ "$ready" = True ] && { [ -z "$boot" ] || [ "$id" != "$boot" ]; }; then
    break
  fi
  sleep 10
done
echo "$node is back up and Ready."
kubectl delete pod "$pod" --namespace ${REBOOT_NAMESPACE} --ignore-not-found
kubectl uncordon "$node"
if [ "$(kubectl get node "$node" -o jsonpath='{.spec.unschedulable}')" = true ]; then
  echo "Error: $node came back but is still cordoned."
  exit 1
fi
echo "$node rebooted, is Ready and takes pods again."
`;

const HOST_COMMAND = [
  "nsenter",
  "--target",
  "1",
  "--mount",
  "--uts",
  "--ipc",
  "--net",
  "--pid",
  "--",
  "systemctl",
  "reboot",
];

export const rebootPodName = (node: string) =>
  `${product.ownerMarker.externalPrefix}reboot-${node}`.slice(0, 63).replace(/[-.]+$/, "");

export function rebootPod(node: string, image: string): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: rebootPodName(node), namespace: REBOOT_NAMESPACE, labels: deployedLabel() },
    spec: {
      nodeName: node,
      hostPID: true,
      restartPolicy: "Never",
      // The node is cordoned and may carry any taint by now.
      tolerations: [{ operator: "Exists" }],
      terminationGracePeriodSeconds: 0,
      containers: [
        {
          name: "reboot",
          image,
          command: HOST_COMMAND,
          securityContext: { privileged: true, runAsUser: 0, runAsNonRoot: false },
          resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { memory: "64Mi" } },
        },
      ],
    },
  } as KubeObject;
}

// The console's own pod, to warn before draining its node. Only in the
// image (a dev server in another pod has a hostname too).
export const nodeActionEnv = {
  consolePod(env: NodeJS.ProcessEnv = process.env): { name: string; namespace: string } | undefined {
    if (env.NODE_ENV !== "production" || !env.POD_NAMESPACE || !env.HOSTNAME) return undefined;
    return { name: env.HOSTNAME, namespace: env.POD_NAMESPACE };
  },
};

interface NodeObject extends KubeObject {
  spec?: { unschedulable?: boolean };
  status?: { conditions?: Array<{ type: string; status: string }> };
}

interface PodObject extends KubeObject {
  spec?: { nodeName?: string; volumes?: Array<{ emptyDir?: unknown }> };
  status?: { phase?: string };
}

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>;
}

interface PdbObject extends KubeObject {
  spec?: { selector?: LabelSelector };
  status?: { disruptionsAllowed?: number };
}

const isReady = (n: NodeObject) =>
  n.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") === true;
const isControlPlane = (n: NodeObject) => CONTROL_PLANE_LABELS.some((l) => n.metadata.labels?.[l] !== undefined);

function matches(selector: LabelSelector | undefined, labels: Record<string, string>): boolean {
  // An empty selector in policy/v1 selects every pod in the namespace.
  if (!selector) return false;
  for (const [k, v] of Object.entries(selector.matchLabels ?? {})) if (labels[k] !== v) return false;
  for (const e of selector.matchExpressions ?? []) {
    const has = Object.hasOwn(labels, e.key);
    const value = labels[e.key];
    if (e.operator === "In" && !(has && e.values?.includes(value!))) return false;
    if (e.operator === "NotIn" && has && e.values?.includes(value!)) return false;
    if (e.operator === "Exists" && !has) return false;
    if (e.operator === "DoesNotExist" && has) return false;
  }
  return true;
}

// What kubectl drain (without --force) does with each pod, in its own order
// of filters: DaemonSet, mirror, local storage, unreplicated.
export function drainPods(
  pods: readonly PodObject[],
  pdbs: readonly PdbObject[],
  options: Required<Pick<NodeDrainOptions, "ignoreDaemonSets" | "deleteEmptyDirData">>
): DrainPod[] {
  return pods.map((pod): DrainPod => {
    const ref = pod.metadata.ownerReferences?.find((o) => o.controller);
    const base: DrainPod = {
      namespace: pod.metadata.namespace ?? "",
      name: pod.metadata.name,
      ...(ref ? { owner: `${ref.kind}/${ref.name}` } : {}),
      outcome: "evict",
    };
    const finished = pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed";
    if (ref?.kind === "DaemonSet") {
      return options.ignoreDaemonSets
        ? { ...base, outcome: "skip", reason: "DaemonSet pod, left in place." }
        : {
            ...base,
            outcome: "block",
            reason: "DaemonSet pod; the drain refuses it unless DaemonSet pods are left in place.",
          };
    }
    if (pod.metadata.annotations?.[MIRROR_ANNOTATION] !== undefined) {
      return { ...base, outcome: "skip", reason: "Static pod, run by the node itself; left in place." };
    }
    if (finished) return base;
    if (!options.deleteEmptyDirData && pod.spec?.volumes?.some((v) => v.emptyDir !== undefined)) {
      return {
        ...base,
        outcome: "block",
        reason: "Uses an emptyDir volume, whose data an eviction loses; allow that to drain it.",
      };
    }
    if (!ref) {
      return {
        ...base,
        outcome: "block",
        reason: "No controller would start it again elsewhere, and the drain never forces a pod off.",
      };
    }
    const labels = pod.metadata.labels ?? {};
    const pdb = pdbs.find((p) => p.metadata.namespace === pod.metadata.namespace && matches(p.spec?.selector, labels));
    if (pdb && (pdb.status?.disruptionsAllowed ?? 0) === 0) {
      return {
        ...base,
        outcome: "wait",
        reason: "Its PodDisruptionBudget allows no disruption right now; the drain waits for it.",
        pdb: pdb.metadata.name,
      };
    }
    return base;
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const VERB: Record<NodeActionRequest["kind"], string> = {
  "node-cordon": "Cordon",
  "node-uncordon": "Uncordon",
  "node-drain": "Drain",
  "node-reboot": "Reboot",
};

function drainArgv(node: string, o: Required<NodeDrainOptions>): string[] {
  return [
    "kubectl",
    "drain",
    node,
    `--ignore-daemonsets=${o.ignoreDaemonSets}`,
    `--delete-emptydir-data=${o.deleteEmptyDirData}`,
    `--timeout=${o.timeoutSeconds}s`,
  ];
}

async function list<T extends KubeObject>(ctx: ActionContext, ref: ResourceRef, options = {}): Promise<T[]> {
  const found = await ctx.k8s!.list<T>(ref, options);
  return found === "absent" ? [] : found;
}

export const nodeActions = {
  "node-cordon": { kind: "node-cordon", render },
  "node-uncordon": { kind: "node-uncordon", render },
  "node-drain": { kind: "node-drain", render },
  "node-reboot": { kind: "node-reboot", render },
} satisfies { [K in NodeActionRequest["kind"]]: ActionRecipe<Extract<NodeActionRequest, { kind: K }>> };

async function render(request: NodeActionRequest, ctx: ActionContext): Promise<ActionRendered> {
  const node = request.node;
  const release = `node-${node}`;
  const consolePod = nodeActionEnv.consolePod();
  const base = { appId: release, release, namespace: consolePod?.namespace ?? REBOOT_NAMESPACE, version: "" };
  const title = `${VERB[request.kind]} ${node}`;
  const blocked = (blockedBy: string, pods?: DrainPod[]): ActionRendered => ({
    ...base,
    plan: {
      kind: request.kind,
      title,
      allowed: false,
      blockedBy,
      steps: [],
      changes: [],
      creates: [],
      warnings: [],
      ...(pods ? { pods } : {}),
    },
    steps: [],
    files: {},
  });

  if (!NODE_NAME.test(node)) return blocked(`"${node}" is not a node name.`);
  if (!ctx.k8s) return blocked("The cluster can't be read, so the node can't be checked.");
  const found = await ctx.k8s.get<NodeObject>(RESOURCES.nodes, node);
  if (!found || found === "absent") return blocked(`There is no node named ${node}.`);
  if (!ctx.enabled) {
    return blocked(`Deploys are off.${ctx.enableHint ? ` Turn them on with: ${ctx.enableHint}` : ""}`);
  }
  const cordoned = found.spec?.unschedulable === true;
  const changes: PlannedObject[] = [{ kind: "Node", name: node }];
  const plan = (rest: Partial<DeployActionPlan> & Pick<DeployActionPlan, "steps">): DeployActionPlan => ({
    kind: request.kind,
    title,
    allowed: true,
    changes,
    creates: [],
    warnings: [],
    ...rest,
  });

  if (request.kind === "node-cordon" || request.kind === "node-uncordon") {
    const cordon = request.kind === "node-cordon";
    if (cordon && cordoned) return blocked(`${node} is already cordoned.`);
    if (!cordon && !cordoned) return blocked(`${node} is not cordoned.`);
    const argv = ["kubectl", cordon ? "cordon" : "uncordon", node];
    const done = cordon
      ? `${node} is cordoned; its running pods stay.`
      : `${node} is uncordoned and takes new pods again.`;
    return {
      ...base,
      plan: plan({
        steps: [{ label: title, commands: [display(argv)] }],
        rollback: cordon ? `Uncordon ${node} to take new pods again.` : `Cordon ${node} again to stop new pods.`,
        warnings: cordon ? ["New pods stop landing on it; the ones running there keep running."] : [],
      }),
      steps: [{ argv }, { argv: ["echo", done] }],
      files: {},
    };
  }

  const options: Required<NodeDrainOptions> = {
    ignoreDaemonSets: request.ignoreDaemonSets ?? true,
    deleteEmptyDirData: request.deleteEmptyDirData ?? false,
    timeoutSeconds: request.timeoutSeconds ?? DRAIN_TIMEOUT_DEFAULT,
  };
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 30 || options.timeoutSeconds > 3600) {
    return blocked("The drain timeout is 30 to 3600 seconds.");
  }
  const reboot = request.kind === "node-reboot";
  const nodes = await list<NodeObject>(ctx, RESOURCES.nodes);
  const others = nodes.filter((n) => n.metadata.name !== node);
  if (others.length === 0) {
    return blocked(
      `${node} is the only node; ${reboot ? "rebooting" : "draining"} it would leave nothing to run its pods.`
    );
  }
  if (reboot && !isReady(found)) {
    return blocked(`${node} is not Ready, so nothing can run on it to reboot it; restart it from its console.`);
  }

  const [pods, pdbs] = await Promise.all([
    list<PodObject>(ctx, RESOURCES.pods, { fieldSelector: `spec.nodeName=${node}` }),
    list<PdbObject>(ctx, PDBS).catch(() => [] as PdbObject[]),
  ]);
  const onNode = pods.filter((p) => p.spec?.nodeName === node);
  const drained = drainPods(onNode, pdbs, options);
  const blocking = drained.filter((p) => p.outcome === "block");
  if (blocking.length > 0) {
    const names = blocking.slice(0, 3).map((p) => `${p.namespace}/${p.name}`);
    return blocked(
      `${plural(blocking.length, "pod")} would stop the drain (${names.join(", ")}${blocking.length > 3 ? ", …" : ""}); ` +
        "each one says why below.",
      drained
    );
  }

  const warnings: string[] = [];
  if (
    consolePod &&
    onNode.some((p) => p.metadata.namespace === consolePod.namespace && p.metadata.name === consolePod.name)
  ) {
    warnings.push(`${node} runs this console's own pod: it moves to another node and the page reconnects.`);
  }
  if (!others.some((n) => isReady(n) && n.spec?.unschedulable !== true)) {
    warnings.push(`No other node is Ready and schedulable, so ${node}'s pods wait as Pending until one is.`);
  }
  const lastControlPlane = isControlPlane(found) && !others.some((n) => isControlPlane(n) && isReady(n));
  if (reboot && lastControlPlane) {
    warnings.push(`${node} is the only control-plane node: the cluster's API is down until it is back.`);
  }
  const waits = drained.filter((p) => p.outcome === "wait");
  if (waits.length > 0) {
    const budgets = [...new Set(waits.map((p) => `${p.namespace}/${p.pdb}`))];
    warnings.push(
      `${plural(budgets.length, "PodDisruptionBudget")} (${budgets.join(", ")}) allow no disruption right now; ` +
        `the drain waits up to ${options.timeoutSeconds}s for ${budgets.length === 1 ? "it" : "them"}.`
    );
  }
  if (reboot) {
    warnings.push(
      `The reboot runs as a privileged pod on ${node} in ${REBOOT_NAMESPACE} (systemctl reboot in the host's namespaces).`
    );
  }

  const evicted = drained.filter((p) => p.outcome === "evict" || p.outcome === "wait").length;
  const steps: DeployActionStep[] = [
    {
      label: `Cordon ${node} and evict ${plural(evicted, "pod")}`,
      commands: [display(drainArgv(node, options))],
    },
  ];
  const creates: PlannedObject[] = [];
  if (reboot) {
    const name = rebootPodName(node);
    steps.push(
      {
        label: `Reboot ${node}`,
        commands: [`kubectl create pod ${REBOOT_NAMESPACE}/${name} on ${node}`, display(HOST_COMMAND)],
      },
      { label: `Wait up to ${REBOOT_WAIT_SECONDS / 60} minutes for ${node} to come back Ready`, commands: [] },
      { label: `Uncordon ${node}`, commands: [display(["kubectl", "uncordon", node])] }
    );
    creates.push({ kind: "Pod", name, namespace: REBOOT_NAMESPACE });
  }

  return {
    ...base,
    plan: plan({
      steps,
      creates,
      warnings,
      pods: drained,
      downtime: reboot
        ? `${node} is down while it reboots; its pods restart on other nodes, and a workload with one replica is down until its pod runs again.`
        : `Pods on ${node} restart on other nodes; a workload with one replica is down until its pod runs again.`,
      rollback: `If a step fails, ${node} stays cordoned; uncordon it once it is healthy.`,
    }),
    steps: [],
    script: reboot ? REBOOT_SCRIPT : DRAIN_SCRIPT,
    // The drain's own timeout, plus the reboot wait, plus room to start.
    deadlineSeconds: options.timeoutSeconds + (reboot ? REBOOT_WAIT_SECONDS : 0) + 300,
    avoidNode: node,
    files: {
      node,
      "ignore-daemonsets": String(options.ignoreDaemonSets),
      "delete-emptydir-data": String(options.deleteEmptyDirData),
      timeout: String(options.timeoutSeconds),
      ...(reboot
        ? {
            "pod-name": rebootPodName(node),
            "reboot-wait": String(REBOOT_WAIT_SECONDS),
            "reboot-pod.json": JSON.stringify(rebootPod(node, ctx.image)),
          }
        : {}),
    },
  };
}
