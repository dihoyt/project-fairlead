export type LinkKind = "node" | "pod" | "pvc" | "certificate";

export interface LinkTarget {
  kind: LinkKind;
  namespace?: string;
  name?: string;
}

export type Linker = (target: LinkTarget) => string | undefined;

// Rancher's cluster explorer names resources by their lowercase kind (CRDs
// as "<group>.<kind>"); Headlamp by plural. Without a name, the list page.
const RANCHER: Record<LinkKind, string> = {
  node: "node",
  pod: "pod",
  pvc: "persistentvolumeclaim",
  certificate: "cert-manager.io.certificate",
};
const HEADLAMP: Partial<Record<LinkKind, string>> = {
  node: "nodes",
  pod: "pods",
  pvc: "persistentvolumeclaims",
};

const path = (segment: string, t: LinkTarget) =>
  [segment, ...(t.name ? [t.namespace, t.name].filter((p): p is string => !!p) : [])].map(encodeURIComponent).join("/");

export function createLinker(urls: () => { rancher: string; headlamp: string }): Linker {
  return (target) => {
    const { rancher, headlamp } = urls();
    if (rancher) return `${rancher}/${path(RANCHER[target.kind], target)}`;
    const segment = HEADLAMP[target.kind];
    if (headlamp && segment) return `${headlamp}/${path(segment, target)}`;
    return undefined;
  };
}
