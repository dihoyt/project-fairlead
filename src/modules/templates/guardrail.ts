import type { KubeObject } from "../../contracts/k8s.js";
import type { GuardrailRule, GuardrailViolation } from "../../contracts/templates.js";

const ALLOWED_KINDS = new Set([
  "Namespace",
  "Deployment",
  "Service",
  "PersistentVolumeClaim",
  "ConfigMap",
  "Secret",
  "ServiceAccount",
  "Role",
  "RoleBinding",
]);

// Pod Security "baseline": the capabilities a container may add.
const BASELINE_CAPABILITIES = new Set([
  "AUDIT_WRITE",
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "MKNOD",
  "NET_BIND_SERVICE",
  "SETFCAP",
  "SETGID",
  "SETPCAP",
  "SETUID",
  "SYS_CHROOT",
]);

const ADMIN_ROLES = new Set(["cluster-admin", "admin", "edit"]);

type Obj = Record<string, unknown>;
const asObj = (value: unknown): Obj | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : undefined;
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// Every rendered object, checked whatever produced it: the renderer never
// writes any of this, so a finding here means a template or the renderer
// is wrong, and nothing runs. The chart's admission policy holds the same
// line in the cluster.
export function checkManifests(
  objects: readonly KubeObject[],
  namespace: string,
  extraKinds: ReadonlySet<string> = new Set()
): GuardrailViolation[] {
  const out: GuardrailViolation[] = [];
  for (const obj of objects) {
    const kind = obj.kind ?? "?";
    const name = `${kind}/${obj.metadata?.name ?? "?"}`;
    const add = (rule: GuardrailRule, path: string, message: string) => out.push({ rule, object: name, path, message });

    if (kind === "ClusterRole" || kind === "ClusterRoleBinding") {
      add("cluster-rbac", "kind", `A ${kind} grants rights across the whole cluster.`);
      continue;
    }
    if (!ALLOWED_KINDS.has(kind) && !extraKinds.has(kind)) {
      add("kind", "kind", `A template may not create a ${kind}.`);
      continue;
    }
    if (kind === "Namespace" ? obj.metadata.name !== namespace : obj.metadata.namespace !== namespace) {
      add(
        "kind",
        kind === "Namespace" ? "metadata.name" : "metadata.namespace",
        `Outside the app's namespace ${namespace}.`
      );
    }
    if (kind === "RoleBinding") {
      const ref = asObj(obj.roleRef);
      if (ref?.kind === "ClusterRole" && ADMIN_ROLES.has(String(ref.name))) {
        add("cluster-rbac", "roleRef", `Binds the ${String(ref.name)} ClusterRole.`);
      }
    }
    if (kind === "Role") {
      asList(obj.rules).forEach((rule, i) => {
        const r = asObj(rule) ?? {};
        for (const field of ["verbs", "resources", "apiGroups"]) {
          if (asList(r[field]).includes("*")) add("cluster-rbac", `rules[${i}].${field}`, `Grants "*" ${field}.`);
        }
      });
    }
    if (kind === "Deployment") {
      const pod = asObj(asObj(asObj(obj.spec)?.template)?.spec);
      if (pod) checkPod(pod, "spec.template.spec", add);
    }
  }
  return out;
}

function checkPod(pod: Obj, base: string, add: (rule: GuardrailRule, path: string, message: string) => void): void {
  if (pod.hostNetwork === true) add("host-network", `${base}.hostNetwork`, "Uses the node's network.");
  if (pod.hostPID === true) add("host-pid", `${base}.hostPID`, "Sees the node's processes.");
  if (pod.hostIPC === true) add("host-ipc", `${base}.hostIPC`, "Shares the node's IPC.");
  asList(pod.volumes).forEach((volume, i) => {
    if (asObj(volume)?.hostPath !== undefined) {
      add("host-path", `${base}.volumes[${i}].hostPath`, "Mounts a directory of the node (hostPath).");
    }
  });
  for (const field of ["initContainers", "containers"]) {
    asList(pod[field]).forEach((container, i) => {
      const c = asObj(container) ?? {};
      const path = `${base}.${field}[${i}]`;
      const sc = asObj(c.securityContext);
      if (sc?.privileged === true) add("privileged", `${path}.securityContext.privileged`, "Runs privileged.");
      if (sc?.allowPrivilegeEscalation === true) {
        add("privilege-escalation", `${path}.securityContext.allowPrivilegeEscalation`, "Allows privilege escalation.");
      }
      for (const cap of asList(asObj(sc?.capabilities)?.add)) {
        if (!BASELINE_CAPABILITIES.has(String(cap))) {
          add("capabilities", `${path}.securityContext.capabilities.add`, `Adds the ${String(cap)} capability.`);
        }
      }
      asList(c.ports).forEach((port, j) => {
        if (asObj(port)?.hostPort !== undefined) {
          add("host-port", `${path}.ports[${j}].hostPort`, "Opens a port on the node itself.");
        }
      });
    });
  }
}
