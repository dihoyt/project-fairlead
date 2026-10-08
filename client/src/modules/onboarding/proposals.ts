import type { CatalogAppView, IngressHost } from "@contracts/catalog";
import type { CheckView } from "@contracts/checks";

export interface CheckProposal {
  host: string;
  url: string;
  label: string;
}

// The host a check already watches: an http check's URL host, a tcp check's
// "host:port" host.
export function checkedHost(check: Pick<CheckView, "kind" | "target">): string {
  if (check.kind === "tcp") return check.target.replace(/:\d+$/, "").toLowerCase();
  try {
    return new URL(check.target).hostname.toLowerCase();
  } catch {
    return check.target.toLowerCase();
  }
}

// One HTTP check per Ingress host nobody checks yet, named after the catalog
// app it belongs to when discovery matched one, else after its Ingress.
export function checkProposals(
  hosts: IngressHost[],
  checks: Array<Pick<CheckView, "kind" | "target">>,
  apps: CatalogAppView[] = []
): CheckProposal[] {
  const watched = new Set(checks.map(checkedHost));
  const seen = new Set<string>();
  const out: CheckProposal[] = [];
  for (const ingress of hosts) {
    const host = ingress.host.toLowerCase();
    if (watched.has(host) || seen.has(host) || host.startsWith("*")) continue;
    seen.add(host);
    const app = ingress.appId ? apps.find((a) => a.id === ingress.appId) : undefined;
    out.push({ host, url: ingress.url, label: app?.name ?? ingress.ingress });
  }
  return out;
}
