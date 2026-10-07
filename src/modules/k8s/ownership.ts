import type { KubeObject, ManagedBy } from "../../contracts/k8s.js";
import { ownerMarkers, product } from "../../product.js";

export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";

// What a GitOps or release tool stamps on the objects it owns. Fleet is
// checked first: it deploys through Helm, so its objects also carry Helm's
// markers, and a change made here would be reverted by Fleet, not Helm.
export function managedBy(obj: KubeObject): ManagedBy | null {
  const labels = obj.metadata.labels ?? {};
  const annotations = obj.metadata.annotations ?? {};
  if ("objectset.rio.cattle.io/hash" in labels || "objectset.rio.cattle.io/id" in annotations) return "fleet";
  if ("argocd.argoproj.io/instance" in labels || "argocd.argoproj.io/tracking-id" in annotations) return "argo";
  if (labels[MANAGED_BY_LABEL] === "Helm" || "meta.helm.sh/release-name" in annotations) return "helm";
  return null;
}

export function ownedLabels(): Record<string, string> {
  return { [MANAGED_BY_LABEL]: product.ownerMarker.labelDomain };
}

// Legacy markers count, so objects written before a rename stay ours.
export function isOwned(obj: KubeObject): boolean {
  const value = obj.metadata.labels?.[MANAGED_BY_LABEL];
  return value !== undefined && ownerMarkers.some((marker) => marker.labelDomain === value);
}
