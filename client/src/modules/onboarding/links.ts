import type { Category } from "@contracts/health";
import type { SettingValue } from "@contracts/auth";

export interface LinkForm {
  rancherUrl: string;
  rancherClusterId: string;
  headlampUrl: string;
  headlampCluster: string;
  longhornUrl: string;
  giteaUrl: string;
  grafanaUrl: string;
}

type CategoryLinks = Partial<Record<Category, Array<{ label: string; url: string }>>>;

// Labels this step writes into health.links; anything else an admin added
// there is kept as it is.
export const MANAGED_LABELS = ["Rancher", "Headlamp", "Grafana", "Longhorn", "Gitea"];

const trim = (url: string) => url.trim().replace(/\/+$/, "");

// The settings each module reads its deep links from, derived from one form:
// workloads and fleet take the Rancher base URL, the cluster checks take the
// explorer URL for this cluster, and health shows each tool on the category
// page it belongs to.
export function linkSettings(form: LinkForm, existing: unknown): Record<string, SettingValue> {
  const rancher = trim(form.rancherUrl);
  const headlamp = trim(form.headlampUrl);
  const clusterId = form.rancherClusterId.trim() || "local";
  const headlampCluster = form.headlampCluster.trim() || "main";

  const links: CategoryLinks = {};
  const prior = (existing && typeof existing === "object" ? existing : {}) as CategoryLinks;
  for (const [category, list] of Object.entries(prior) as Array<[Category, CategoryLinks[Category]]>) {
    const kept = (list ?? []).filter((link) => !MANAGED_LABELS.includes(link.label));
    if (kept.length) links[category] = kept;
  }
  const add = (category: Category, label: string, url: string) => {
    if (!url) return;
    (links[category] ??= []).push({ label, url });
  };
  add("cluster", "Rancher", rancher && `${rancher}/dashboard/c/${clusterId}/explorer`);
  add("cluster", "Headlamp", headlamp && `${headlamp}/c/${headlampCluster}`);
  add("cluster", "Grafana", trim(form.grafanaUrl));
  add("storage", "Longhorn", trim(form.longhornUrl));
  add("backups", "Longhorn", trim(form.longhornUrl));
  add("gitops", "Gitea", trim(form.giteaUrl));
  add("gitops", "Rancher", rancher && `${rancher}/dashboard/c/_/fleet`);

  return {
    "workloads.rancherUrl": rancher,
    "workloads.rancherClusterId": clusterId,
    "fleet.rancherUrl": rancher,
    "cluster.rancherUrl": rancher && `${rancher}/dashboard/c/${clusterId}/explorer`,
    "workloads.headlampUrl": headlamp,
    "workloads.headlampCluster": headlampCluster,
    "cluster.headlampUrl": headlamp && `${headlamp}/c/${headlampCluster}`,
    "longhorn.uiUrl": trim(form.longhornUrl),
    // A JSON setting is sent as its JSON text; the server parses it against the schema.
    "health.links": JSON.stringify(links),
  };
}

// Reads the form back out of the stored settings, so reopening the step shows what is set.
export function formFromSettings(get: (key: string) => string, healthLinks: unknown): LinkForm {
  const links = (healthLinks && typeof healthLinks === "object" ? healthLinks : {}) as CategoryLinks;
  const find = (category: Category, label: string) => links[category]?.find((l) => l.label === label)?.url ?? "";
  return {
    rancherUrl: get("workloads.rancherUrl") || get("fleet.rancherUrl"),
    rancherClusterId: get("workloads.rancherClusterId") || "local",
    headlampUrl: get("workloads.headlampUrl"),
    headlampCluster: get("workloads.headlampCluster") || "main",
    longhornUrl: get("longhorn.uiUrl"),
    giteaUrl: find("gitops", "Gitea"),
    grafanaUrl: find("cluster", "Grafana"),
  };
}
