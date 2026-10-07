import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";

export const MASK = "********";

// Shorter values would mask ordinary words and numbers all over a log.
const MIN_SECRET_LENGTH = 4;

interface SecretRefs {
  spec?: {
    containers?: ContainerRefs[];
    initContainers?: ContainerRefs[];
    volumes?: Array<{
      secret?: { secretName?: string };
      projected?: { sources?: Array<{ secret?: { name?: string } }> };
    }>;
  };
}

interface ContainerRefs {
  env?: Array<{ valueFrom?: { secretKeyRef?: { name?: string } } }>;
  envFrom?: Array<{ secretRef?: { name?: string } }>;
}

// Every Secret the pod's spec names: env, envFrom and volumes.
export function referencedSecrets(pod: KubeObject): string[] {
  const spec = (pod as SecretRefs).spec ?? {};
  const names = new Set<string>();
  const add = (name: string | undefined) => name && names.add(name);
  for (const container of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
    for (const env of container.env ?? []) add(env.valueFrom?.secretKeyRef?.name);
    for (const from of container.envFrom ?? []) add(from.secretRef?.name);
  }
  for (const volume of spec.volumes ?? []) {
    add(volume.secret?.secretName);
    for (const source of volume.projected?.sources ?? []) add(source.secret?.name);
  }
  return [...names].toSorted();
}

// The values of those Secrets, plain and base64-encoded (apps log join URLs
// and basic-auth headers with the encoded form). Reading Secrets is an
// opt-in grant in the chart; without it this returns nothing and only the
// key=value patterns below apply.
export async function secretValues(k8s: K8sApi, pod: KubeObject): Promise<string[]> {
  const values = new Set<string>();
  for (const name of referencedSecrets(pod)) {
    let secret: (KubeObject & { data?: Record<string, string> }) | null | "absent";
    try {
      secret = await k8s.get(RESOURCES.secrets, name, pod.metadata.namespace);
    } catch {
      continue;
    }
    if (!secret || secret === "absent") continue;
    for (const encoded of Object.values(secret.data ?? {})) {
      const value = Buffer.from(encoded, "base64").toString("utf8").trim();
      if (value.length < MIN_SECRET_LENGTH) continue;
      values.add(value);
      const b64 = Buffer.from(value).toString("base64");
      values.add(b64);
      values.add(b64.replace(/=+$/, ""));
    }
  }
  return [...values];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "password=…", "api_key: …", "Bearer …": the value up to the next
// delimiter, whatever Secret it came from.
const ASSIGNMENT =
  /\b((?:[\w-]*[_-])?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b["']?\s*[=:]\s*["']?)([^\s"'&,;]+)/gi;
const BEARER = /\b(bearer\s+)([\w.~+/-]+=*)/gi;

export interface Redactor {
  (line: string): { line: string; redacted: boolean };
}

export function createRedactor(values: string[]): Redactor {
  const exact =
    values.length > 0
      ? new RegExp(
          // Longest first, so a value that contains another is masked whole.
          [...values]
            .toSorted((a, b) => b.length - a.length)
            .map(escape)
            .join("|"),
          "g"
        )
      : null;
  return (line) => {
    let out = exact ? line.replace(exact, MASK) : line;
    out = out.replace(ASSIGNMENT, (_, key: string, value: string) => (value === MASK ? key + value : key + MASK));
    out = out.replace(BEARER, (_, key: string) => key + MASK);
    return { line: out, redacted: out !== line };
  };
}
