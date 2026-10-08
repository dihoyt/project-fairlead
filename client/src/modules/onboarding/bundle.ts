import type { CatalogAppView, IngressHost } from "@contracts/catalog";
import type { BundleRunView } from "@contracts/deploy";
import { apiRequest } from "../../ui";
import { LINK_FIELD, type LinkForm } from "./links";
import { formOf, saveLinks } from "./LinksForm";
import { checkProposals } from "./proposals";

export interface Landed {
  appId: string;
  url: string;
}

// Steps of a run that finished with a URL.
export function landedSteps(run: Pick<BundleRunView, "steps">): Landed[] {
  return run.steps.flatMap((step) =>
    step.state === "succeeded" && step.url ? [{ appId: step.appId, url: step.url }] : []
  );
}

// What a landed app adds to the Links step: its URL in the tool's field,
// where that field is still empty.
export function linksForLanded(form: LinkForm, landed: Landed[], apps: CatalogAppView[]): Partial<LinkForm> {
  const out: Partial<LinkForm> = {};
  for (const { appId, url } of landed) {
    const key = apps.find((app) => app.id === appId)?.linkKey;
    if (!key) continue;
    const field = LINK_FIELD[key];
    if (!form[field].trim() && !out[field]) out[field] = url.replace(/\/+$/, "");
  }
  return out;
}

function asIngressHost({ appId, url }: Landed): IngressHost | undefined {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      url: parsed.origin,
      tls: parsed.protocol === "https:",
      namespace: "",
      ingress: appId,
      appId,
    };
  } catch {
    return undefined;
  }
}

// Wires each landed app in as the Links and Checks steps would: its link
// settings, and an HTTP check unless one already watches its host.
export async function wireLanded(landed: Landed[], apps: CatalogAppView[]): Promise<void> {
  if (!landed.length) return;
  const overview = await apiRequest("GET /api/admin/overview");
  const form = formOf(overview.settings);
  const links = linksForLanded(form, landed, apps);
  if (Object.keys(links).length) await saveLinks(overview.settings, { ...form, ...links });

  const exposed = landed.filter(({ appId }) => apps.find((app) => app.id === appId)?.exposesUi !== false);
  const hosts = exposed.map(asIngressHost).filter((h): h is IngressHost => h !== undefined);
  const checks = await apiRequest("GET /api/checks");
  for (const proposal of checkProposals(hosts, checks, apps)) {
    await apiRequest("POST /api/checks", { body: { label: proposal.label, kind: "http", target: proposal.url } });
  }
}
