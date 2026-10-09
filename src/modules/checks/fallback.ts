import type { CatalogService, IngressHost } from "../../contracts/catalog.js";
import type { DeployService } from "../../contracts/deploy.js";
import type { CheckResult } from "../../contracts/health.js";
import { judge, probe, type CheckSpec, type ProbeOptions, type ProbeOutcome } from "./probe.js";

// The name has no address (yet): no record, or none this resolver can see.
const UNRESOLVED = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_NODATA"]);
// Where the wizard's Access step lives, as a link inside this app.
export const ACCESS_LINK = "#/welcome?step=access";

export function unresolved(spec: CheckSpec, outcome: ProbeOutcome): boolean {
  return spec.kind === "http" && Boolean(outcome.error?.code && UNRESOLVED.has(outcome.error.code));
}

export async function ingressHostFor(
  catalog: CatalogService | undefined,
  target: string
): Promise<IngressHost | undefined> {
  if (!catalog) return undefined;
  let host: string;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  try {
    const report = await catalog.discover();
    return report.ingressHosts.find((h) => h.host.toLowerCase() === host && h.serviceUrl);
  } catch {
    return undefined;
  }
}

// The same request against the app's in-cluster Service, keeping the
// path and query and every expectation except the certificate's.
function serviceSpec(spec: CheckSpec, serviceUrl: string): CheckSpec {
  const original = new URL(spec.target);
  const inside = new URL(serviceUrl);
  inside.pathname = original.pathname;
  inside.search = original.search;
  return { ...spec, target: inside.toString(), insecureSkipVerify: true, tlsWarnDays: 0 };
}

// Rates a check whose hostname doesn't resolve from what its Service says:
// an app that answers inside the cluster but has no DNS yet is a warning
// pointing at the Access step, not an outage. A Tailscale host never
// resolves here (this pod isn't on the tailnet), so the Service is the
// whole answer for it.
export async function rateUnresolved(
  spec: CheckSpec,
  outcome: ProbeOutcome,
  ingress: IngressHost,
  observedAt: string,
  options: ProbeOptions = {}
): Promise<{ result: CheckResult; inside: ProbeOutcome }> {
  const host = ingress.host;
  const insideSpec = serviceSpec(spec, ingress.serviceUrl!);
  const inside = await probe(insideSpec, options);
  const judged = judge(insideSpec, inside, observedAt);
  const raw = { target: spec.target, error: outcome.error, service: ingress.serviceUrl, inside };
  const base = {
    id: spec.id,
    label: spec.label,
    observedAt,
    ...(judged.value !== undefined ? { value: judged.value } : {}),
  };
  const up = judged.status === "ok" || judged.status === "warn";

  if (!up) {
    return {
      result: {
        ...base,
        status: "crit",
        detail: `${host} has no DNS record, and the app does not answer inside the cluster either (${ingress.serviceUrl}): ${judged.detail}`,
        raw,
        deepLink: ACCESS_LINK,
      },
      inside,
    };
  }
  if (ingress.ingressClass === "tailscale") {
    return {
      result: {
        ...base,
        status: judged.status,
        detail: `Up inside the cluster: ${judged.detail}. ${host} answers on your tailnet only, so it is checked through its Service`,
        deepLink: spec.target,
        ...(judged.status === "ok" ? {} : { raw }),
      },
      inside,
    };
  }
  return {
    result: {
      ...base,
      status: "warn",
      detail: `Unreachable: ${host} has no DNS record yet. The app is up inside the cluster (${judged.detail}); finish the Access step to publish it`,
      raw,
      deepLink: ACCESS_LINK,
    },
    inside,
  };
}

// The console's sign-in gate answers 401 to any request without its cookie,
// before the app sees it, so a check without credentials always meets it.
export function metGate(spec: CheckSpec, outcome: ProbeOutcome): boolean {
  return spec.kind === "http" && !spec.authHeader && !spec.expectStatus?.length && outcome.httpStatus === 401;
}

export async function gatedHost(deploy: DeployService | undefined, target: string): Promise<boolean> {
  if (!deploy) return false;
  try {
    const host = new URL(target).hostname.toLowerCase();
    const status = await deploy.gate();
    return status.apps.some((app) => app.state === "gated" && app.hosts.some((h) => h.toLowerCase() === host));
  } catch {
    return false;
  }
}

// Rates a check stopped by the console's own sign-in: the gate answering
// says the route works, and the app's Service says whether the app is up.
export async function rateGated(
  spec: CheckSpec,
  outcome: ProbeOutcome,
  ingress: IngressHost | undefined,
  observedAt: string,
  options: ProbeOptions = {}
): Promise<CheckResult> {
  const base = {
    id: spec.id,
    label: spec.label,
    observedAt,
    deepLink: spec.target,
    ...(outcome.latencyMs !== undefined ? { value: outcome.latencyMs } : {}),
  };
  const gate = `the console's sign-in answered (HTTP 401 in ${outcome.latencyMs ?? 0} ms)`;
  if (!ingress?.serviceUrl) {
    return {
      ...base,
      status: "ok",
      detail: `Behind the console's sign-in: ${gate}; the app itself isn't reachable to check`,
    };
  }
  const insideSpec = serviceSpec(spec, ingress.serviceUrl);
  const inside = await probe(insideSpec, options);
  const judged = judge(insideSpec, inside, observedAt);
  if (judged.status === "ok" || judged.status === "warn") {
    return {
      ...base,
      status: "ok",
      detail: `Behind the console's sign-in: ${gate}, and the app is up inside the cluster (${judged.detail})`,
    };
  }
  return {
    ...base,
    status: "crit",
    detail: `Behind the console's sign-in: ${gate}, but the app does not answer inside the cluster (${ingress.serviceUrl}): ${judged.detail}`,
    raw: { target: spec.target, ...outcome, service: ingress.serviceUrl, inside },
  };
}
