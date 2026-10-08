import type { CatalogEntry, DetectedApp, DiscoveryReport } from "../../contracts/catalog.js";
import type { DeployedRelease, UpgradeCandidate, UpgradeNote, UpgradeReport } from "../../contracts/deploy.js";
import { compareVersions, pickVersion } from "../../contracts/kubeversion.js";
import type { RecipeInput, Step } from "./apps.js";
import { manifestParts } from "./manifest.js";
import { display, HELM_TIMEOUT } from "./plan.js";

export interface UpgradeTarget {
  entry: CatalogEntry;
  release: string;
  namespace: string;
}

export interface UpgradeSteps {
  steps: Step[];
  // Files for the values Secret (a bundled manifest), by name.
  files: Record<string, string>;
  error?: string;
}

// `helm upgrade` without --install, so a release that has gone since fails
// instead of being installed afresh. --reset-then-reuse-values keeps the
// values it was installed with on top of the new chart's defaults; plain
// --reuse-values would drop defaults a newer chart adds.
// A manifest is applied again as pinned; the Ingress rendered from its host
// at install time is left as it is.
export function upgradeSteps({ entry, release, namespace }: UpgradeTarget, version: string): UpgradeSteps {
  const install = entry.install;
  if (install.kind === "helm") {
    const oci = install.repo.startsWith("oci://");
    return {
      steps: [
        {
          argv: [
            "helm",
            "upgrade",
            release,
            oci ? `${install.repo.replace(/\/+$/, "")}/${install.chart}` : install.chart,
            ...(oci ? [] : ["--repo", install.repo]),
            "--version",
            version,
            "--namespace",
            namespace,
            "--reset-then-reuse-values",
            "--wait",
            "--timeout",
            HELM_TIMEOUT,
          ],
        },
      ],
      files: {},
    };
  }
  if (install.kind === "manifest") {
    const parts = manifestParts(entry, bare(entry, release, namespace));
    if (parts.error) return { steps: [], files: {}, error: parts.error };
    return { steps: parts.steps, files: parts.raw };
  }
  return { steps: [], files: {}, error: `${entry.name} is a setting change; there is nothing to upgrade.` };
}

const bare = (app: CatalogEntry, release: string, namespace: string): RecipeInput => ({
  app,
  release,
  namespace,
  inputs: {},
  tls: false,
  scheme: "http",
  chartIngress: true,
  defaults: {},
  generated: () => "",
});

export function notesBetween(
  notes: readonly UpgradeNote[] | undefined,
  from: string | undefined,
  to: string
): UpgradeNote[] {
  return (notes ?? [])
    .filter((note) => {
      const upTo = compareVersions(note.version, to);
      if (upTo === undefined || upTo > 0) return false;
      if (from === undefined) return true;
      const after = compareVersions(note.version, from);
      return after !== undefined && after > 0;
    })
    .toSorted((a, b) => compareVersions(a.version, b.version) ?? 0);
}

// Catalog order, with each app's requires moved before it.
export function installOrder(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();
  const visit = (entry: CatalogEntry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    for (const id of entry.requires) {
      const required = byId.get(id);
      if (required) visit(required);
    }
    out.push(entry);
  };
  for (const entry of entries) visit(entry);
  return out;
}

export interface ReportInput {
  entries: readonly CatalogEntry[];
  discovery?: DiscoveryReport;
  enabled: boolean;
  // The deploy runner's own record: latest job per release.
  releases: readonly DeployedRelease[];
  // Release -> version of its latest succeeded install or upgrade.
  versions: ReadonlyMap<string, string>;
  // Releases with a job pending or running.
  busy: ReadonlySet<string>;
  checkedAt: string;
}

// Ours: discovery says installed by us. Without discovery, or for an app
// discovery doesn't look for, the runner's record of a succeeded install
// stands in.
interface Ours {
  entry: CatalogEntry;
  detected?: DetectedApp;
  record?: DeployedRelease;
}

function ours(input: ReportInput): Ours[] {
  return installOrder(input.entries).flatMap((entry): Ours[] => {
    const record = input.releases.find((r) => r.appId === entry.id);
    if (!input.discovery) return record && input.versions.has(record.release) ? [{ entry, record }] : [];
    const detected = input.discovery.apps.find((app) => app.appId === entry.id);
    // Discovery covers the catalog only; a template instance stands on the record.
    if (!detected) return record && input.versions.has(record.release) ? [{ entry, record }] : [];
    return detected.state === "installed" && detected.ownedByUs ? [{ entry, detected, record }] : [];
  });
}

export function upgradeReport(input: ReportInput): UpgradeReport {
  const kubernetes = input.discovery?.kubernetesVersion;
  const apps = ours(input).map(({ entry, detected, record }): UpgradeCandidate => {
    const release = record?.release ?? detected?.release ?? entry.id;
    const namespace = record?.namespace ?? detected?.namespace ?? entry.namespace;
    const currentVersion = input.versions.get(release) ?? detected?.chartVersion;
    const url = detected?.urls[0];
    const base = {
      appId: entry.id,
      release,
      namespace,
      ...(currentVersion ? { currentVersion } : {}),
      ...(url ? { url } : {}),
    };
    if (entry.install.kind === "patch") {
      return {
        ...base,
        pinnedVersion: "",
        fellBack: false,
        state: "blocked",
        reason: `${entry.name} is a setting change; there is nothing to upgrade.`,
        notes: [],
        commands: [],
      };
    }
    const pinnedVersion = entry.install.version;
    const picked = pickVersion(entry.install, kubernetes);
    if (!picked.ok) {
      return {
        ...base,
        pinnedVersion,
        fellBack: false,
        state: "current",
        reason: picked.reason,
        notes: [],
        commands: [],
      };
    }
    const targetVersion = picked.version;
    const target = { ...base, pinnedVersion, targetVersion, fellBack: picked.fellBack };
    const steps = upgradeSteps({ entry, release, namespace }, targetVersion);
    const commands = steps.steps.map((step) => display(step.argv));
    const notes = notesBetween(entry.upgradeNotes, currentVersion, targetVersion);
    const blocked = !input.enabled
      ? "Deploys are turned off for this install."
      : input.busy.has(release)
        ? `A deploy job for ${release} is running.`
        : steps.error;
    if (blocked) return { ...target, state: "blocked", reason: blocked, notes, commands: [] };
    if (!currentVersion) {
      return { ...target, state: "unknown", reason: "No record of the version installed here.", notes, commands };
    }
    const order = compareVersions(targetVersion, currentVersion);
    if (order === undefined) {
      return {
        ...target,
        state: "unknown",
        reason: `Can't tell whether ${targetVersion} is newer than ${currentVersion}.`,
        notes,
        commands,
      };
    }
    if (order > 0) return { ...target, state: "available", notes, commands };
    const reason =
      order < 0
        ? `Newer than the catalog's ${targetVersion}.`
        : picked.fellBack
          ? `${pinnedVersion} needs Kubernetes ${entry.install.kubeVersion}; this cluster runs ${kubernetes}.`
          : "Already at the catalog's version.";
    return { ...target, state: "current", reason, notes: [], commands: [] };
  });
  return {
    checkedAt: input.checkedAt,
    ...(kubernetes ? { kubernetesVersion: kubernetes } : {}),
    enabled: input.enabled,
    apps,
  };
}
