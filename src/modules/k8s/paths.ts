import type { KubeObject, ResourceRef } from "../../contracts/k8s.js";

const seg = encodeURIComponent;

export const apiVersionOf = (ref: ResourceRef) => (ref.group ? `${ref.group}/${ref.version}` : ref.version);

export function groupVersionPath(ref: Pick<ResourceRef, "group" | "version">): string {
  return ref.group ? `/apis/${seg(ref.group)}/${seg(ref.version)}` : `/api/${seg(ref.version)}`;
}

// The collection path; all namespaces when a namespaced resource is given no namespace.
export function collectionPath(ref: ResourceRef, namespace?: string): string {
  const scope = ref.namespaced && namespace ? `/namespaces/${seg(namespace)}` : "";
  return `${groupVersionPath(ref)}${scope}/${seg(ref.plural)}`;
}

export function objectPath(ref: ResourceRef, name: string, namespace?: string): string {
  if (ref.namespaced && !namespace) throw new Error(`${ref.kind} "${name}" is namespaced: a namespace is required.`);
  return `${collectionPath(ref, namespace)}/${seg(name)}`;
}

// List items arrive without kind and apiVersion; consumers get whole objects.
export function withTypeMeta<T extends KubeObject>(ref: ResourceRef, obj: T): T {
  return { ...obj, apiVersion: obj.apiVersion ?? apiVersionOf(ref), kind: obj.kind ?? ref.kind };
}

export const objectKey = (obj: KubeObject) => `${obj.metadata.namespace ?? ""}/${obj.metadata.name}`;

// "core" for the core group, else the group's first label: "longhorn.io" → "longhorn".
export const groupShortName = (group: string) => (group ? group.split(".")[0]! : "core");
