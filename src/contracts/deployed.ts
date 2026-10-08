// The label marking objects this product's deploy runner installed, beside
// Helm's own app.kubernetes.io/managed-by (which charts set to "Helm", so
// ownedLabels() can't ride through a chart). The deploy module adds it via
// each chart's labels key; the catalog module reads it for
// DetectedApp.ownedByUs, together with Services.deploy.releases() for
// charts that drop it.
//
// Needs Node (reads product.json): the client never imports this file.

import type { KubeObject } from "./k8s.js";
import { ownerMarkers, product } from "../product.js";

const VALUE = "deploy";
const key = (labelDomain: string) => `${labelDomain}/deployed-by`;

export function deployedLabel(): Record<string, string> {
  return { [key(product.ownerMarker.labelDomain)]: VALUE };
}

// Accepts the current marker's domain and every legacy one.
export function isDeployedByUs(obj: KubeObject): boolean {
  const labels = obj.metadata.labels ?? {};
  return ownerMarkers.some((marker) => labels[key(marker.labelDomain)] === VALUE);
}
