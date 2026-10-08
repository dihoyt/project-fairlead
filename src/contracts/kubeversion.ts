// Matching a cluster's Kubernetes version against a chart's kubeVersion
// constraint, as Helm does, and picking the newest catalog pin that fits.
// Pure, so the client can import it.

import type { InstallSource } from "./catalog.js";

type Triple = [number, number, number];

const num = (part: string | undefined) => (part === undefined || part === "x" || part === "*" ? 0 : Number(part));

// "v1.31.4+k3s1" -> [1, 31, 4]. Pre-release and build parts are dropped:
// Helm's "-0" suffix exists only to let pre-release clusters match.
function parse(version: string): Triple | null {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(version.trim());
  if (!m) return null;
  return [num(m[1]), num(m[2]), num(m[3])];
}

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function satisfiesOne(version: Triple, comparator: string): boolean {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(\S+)$/.exec(comparator);
  if (!m) return false;
  const [, op = "=", raw = ""] = m;
  const target = parse(raw);
  if (!target) return false;
  const c = compare(version, target);
  switch (op) {
    case ">=":
      return c >= 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case "<":
      return c < 0;
    case "^":
      // Major 1 everywhere in practice: ^1.25 means >=1.25.0 <2.0.0.
      return c >= 0 && version[0] === target[0];
    case "~":
      return c >= 0 && version[0] === target[0] && version[1] === target[1];
    default:
      return c === 0;
  }
}

// Supports what charts use: space- or comma-separated comparators (AND),
// "||" alternatives (OR), and >=, >, <=, <, =, ^, ~. An empty or missing
// constraint accepts anything; one it can't parse accepts nothing.
export function satisfiesKubeVersion(constraint: string | undefined, gitVersion: string): boolean {
  if (!constraint?.trim()) return true;
  const version = parse(gitVersion);
  if (!version) return false;
  return constraint.split("||").some((alternative) => {
    const comparators = alternative
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
      .split(/[\s,]+/)
      .filter(Boolean);
    return comparators.length > 0 && comparators.every((comparator) => satisfiesOne(version, comparator));
  });
}

export type PickedVersion =
  { ok: true; version: string; kubeVersion?: string; fellBack: boolean } | { ok: false; reason: string };

const pick = (c: { version: string; kubeVersion?: string }, fellBack: boolean): PickedVersion => ({
  ok: true,
  version: c.version,
  ...(c.kubeVersion ? { kubeVersion: c.kubeVersion } : {}),
  fellBack,
});

// The pinned version if the cluster fits it, else the newest fallback that
// fits. With no known cluster version the pin is used unchecked.
export function pickVersion(install: InstallSource, gitVersion: string | undefined): PickedVersion {
  if (install.kind === "patch") return { ok: false, reason: "A patch has no version to pick." };
  const candidates = [
    { version: install.version, kubeVersion: install.kubeVersion },
    ...(install.kind === "helm" ? (install.fallbacks ?? []) : []),
  ];
  const head = candidates[0]!;
  if (!gitVersion) return pick(head, false);
  const index = candidates.findIndex((c) => satisfiesKubeVersion(c.kubeVersion, gitVersion));
  if (index >= 0) return pick(candidates[index]!, index > 0);
  return {
    ok: false,
    reason: `Needs Kubernetes ${candidates.map((c) => `${c.kubeVersion} (${c.version})`).join(" or ")}; this cluster runs ${gitVersion}.`,
  };
}
