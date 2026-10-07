import type { BackupsRegistry, ProtectedVolume } from "../../contracts/backups.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import type { OnboardingState } from "../../contracts/onboarding.js";
import type { Logger } from "../../contracts/runtime.js";

export type Findings = OnboardingState["findings"];

interface NodeStatus {
  conditions?: Array<{ type?: string; status?: string }>;
}

function nodeReady(node: KubeObject): boolean {
  return (
    (node.status as NodeStatus | undefined)?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false
  );
}

// The counts behind the wizard's last step. Each part is independent: a
// missing k8s service or a failing source leaves its own count at zero
// (logged) rather than failing the whole state.
export async function collectFindings(
  k8s: K8sApi | undefined,
  backups: BackupsRegistry,
  log: Logger
): Promise<Findings> {
  const findings: Findings = { unprotectedPvcs: 0, unhealthyNodes: 0, failingBackups: 0 };

  const volumes: ProtectedVolume[] = [];
  await Promise.all(
    backups.sources().map(async (source) => {
      try {
        const listed = await source.list();
        if (listed !== "absent") volumes.push(...listed);
      } catch (err) {
        log.warn("backup source failed", { source: source.id, error: String(err) });
      }
    })
  );
  const failing = new Set(volumes.filter((v) => v.lastAttempt && !v.lastAttempt.ok).map((v) => v.pvc.uid));
  findings.failingBackups = failing.size;

  if (!k8s) return findings;

  try {
    const nodes = await k8s.list(RESOURCES.nodes);
    if (nodes !== "absent") findings.unhealthyNodes = nodes.filter((node) => !nodeReady(node)).length;
  } catch (err) {
    log.warn("listing nodes failed", { error: String(err) });
  }

  try {
    const pvcs = await k8s.list(RESOURCES.pvcs);
    if (pvcs !== "absent") {
      const covered = new Set(volumes.map((v) => v.pvc.uid));
      findings.unprotectedPvcs = pvcs.filter((pvc) => !covered.has(pvc.metadata.uid ?? "")).length;
    }
  } catch (err) {
    log.warn("listing PVCs failed", { error: String(err) });
  }

  return findings;
}
