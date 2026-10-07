import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCES, type KubeObject, type ResourceRef } from "../../../src/contracts/k8s.js";

// A fixture set is a directory in the layout scripts/capture-fixtures.sh
// writes: <group-or-core>/<plural>.json lists, kubelet/summary-<node>.json,
// core/version.json, absent.txt. The synthetic set and a real capture are
// interchangeable: extract the archive to test/fixtures/<name>/ and load it
// by name.

export const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

export interface FixtureList {
  ref: ResourceRef;
  items: KubeObject[];
}

export interface FixtureSet {
  name: string;
  dir: string;
  lists: FixtureList[];
  // Resources `kubectl get` could not read when the set was captured; the
  // fake API answers 404 for them, as for a CRD that is not installed.
  absent: Array<{ plural: string; group: string }>;
  // kubelet stats summaries by node name.
  kubelet: Record<string, unknown>;
  version?: Record<string, unknown>;
  // Pod logs by "namespace/pod", from logs/<namespace>/<pod>.log (not part of
  // a capture; synthetic sets only).
  logs: Record<string, string[]>;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));

function refFor(group: string, plural: string, items: KubeObject[]): ResourceRef {
  const known = Object.values<ResourceRef>(RESOURCES).find((r) => r.group === group && r.plural === plural);
  if (known) return known;
  const first = items[0];
  const apiVersion = first?.apiVersion ?? (group ? `${group}/v1` : "v1");
  return {
    group,
    version: apiVersion.split("/").pop() ?? "v1",
    plural,
    kind: first?.kind ?? plural,
    namespaced: items.some((o) => o.metadata.namespace !== undefined),
  };
}

export function listFixtureSets(): string[] {
  return readdirSync(FIXTURES_ROOT).filter((entry) => statSync(join(FIXTURES_ROOT, entry)).isDirectory());
}

// The set tests run against: FIXTURE_SET from the environment, else the
// synthetic one. Tests that assert on named scenarios import them from the
// synthetic set directly instead.
export function defaultFixtureSetName(): string {
  return process.env.FIXTURE_SET || "synthetic";
}

export function loadFixtureSet(name: string = defaultFixtureSetName()): FixtureSet {
  const dir = join(FIXTURES_ROOT, name);
  if (!existsSync(dir)) {
    throw new Error(`fixture set "${name}" not found in ${FIXTURES_ROOT} (have: ${listFixtureSets().join(", ")})`);
  }
  const set: FixtureSet = { name, dir, lists: [], absent: [], kubelet: {}, logs: {} };

  for (const file of walk(dir).toSorted()) {
    const rel = relative(dir, file).split("\\").join("/");
    const [top = "", ...rest] = rel.split("/");
    if (rel === "absent.txt") {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const resource = line.split(":")[0]?.trim();
        // Entries are "plural.group: error" for lists, "/path: not available" for raw reads.
        if (!resource || resource.startsWith("/")) continue;
        const [plural = "", ...group] = resource.split(".");
        set.absent.push({ plural, group: group.join(".") });
      }
    } else if (rel === "core/version.json") {
      set.version = readJson(file);
    } else if (top === "kubelet" && rest[0]?.startsWith("summary-")) {
      set.kubelet[rest[0].slice("summary-".length, -".json".length)] = readJson(file);
    } else if (top === "logs" && rest.length === 2) {
      set.logs[`${rest[0]}/${rest[1]!.replace(/\.log$/, "")}`] = readFileSync(file, "utf8").split("\n").filter(Boolean);
    } else if (rest.length === 1 && rest[0]!.endsWith(".json")) {
      const body = readJson(file);
      if (!Array.isArray(body.items)) continue;
      const group = top === "core" ? "" : top;
      const plural = rest[0]!.slice(0, -".json".length);
      set.lists.push({ ref: refFor(group, plural, body.items), items: body.items });
    }
  }
  return set;
}

export function fixtureItems(set: FixtureSet, ref: ResourceRef): KubeObject[] {
  return set.lists.find((l) => l.ref.group === ref.group && l.ref.plural === ref.plural)?.items ?? [];
}
