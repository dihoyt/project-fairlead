// Creates, or finds again, the OAuth2/OpenID provider and the application
// this install signs in through, using Authentik's REST API with a token an
// admin pastes. Nothing here logs or returns the token or the client secret.
//
// Written against Authentik 2026.8 (the version the catalog pins), API v3,
// bearer-token auth. Paths relied on:
//   GET   /api/v3/core/applications/{slug}/            404 when absent
//   POST  /api/v3/core/applications/                   { name, slug, provider, meta_launch_url }
//   PATCH /api/v3/core/applications/{slug}/            { provider }
//   GET   /api/v3/providers/oauth2/?name=              paginated { results }
//   GET   /api/v3/providers/oauth2/{pk}/               client_id, client_secret, redirect_uris
//   POST  /api/v3/providers/oauth2/                    authorization_flow and invalidation_flow
//                                                      (flow pks) and redirect_uris
//                                                      [{ matching_mode, url }] are required;
//                                                      grant_types defaults to none
//   PATCH /api/v3/providers/oauth2/{pk}/               { redirect_uris, grant_types }
//   GET   /api/v3/flows/instances/?slug= | ?designation=
//   GET   /api/v3/propertymappings/provider/scope/?page_size=100   managed, pk
//   GET   /api/v3/crypto/certificatekeypairs/?has_key=true
// The default flows and scope mappings are the ones Authentik's own
// blueprints create; the profile scope carries the "groups" claim.

const TIMEOUT_MS = 15_000;

const AUTHORIZATION_FLOW = "default-provider-authorization-implicit-consent";
const INVALIDATION_FLOW = "default-provider-invalidation-flow";
const SCOPE_MAPPINGS = ["openid", "email", "profile"].map((scope) => `goauthentik.io/providers/oauth2/scope-${scope}`);
// A provider made through the API starts with no grant types, and the
// authorize endpoint then refuses the code flow.
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const SELF_SIGNED = "authentik Self-signed Certificate";

export class AuthentikError extends Error {}

export interface AuthentikTarget {
  // Where the API is called.
  apiUrl: string;
  // Authentik as browsers reach it, which the issuer is built on.
  publicUrl: string;
  token: string;
  slug: string;
  name: string;
  redirectUri: string;
  launchUrl: string;
}

export interface AuthentikOutcome {
  issuer: string;
  clientId: string;
  clientSecret: string;
  application: "created" | "found";
  provider: "created" | "updated" | "unchanged";
}

interface RedirectUri {
  matching_mode: string;
  url: string;
  redirect_uri_type?: string;
}

interface Provider {
  pk: number;
  name: string;
  client_id: string;
  client_secret: string;
  redirect_uris: RedirectUri[];
  grant_types?: string[];
}

interface Application {
  slug: string;
  provider: number | null;
}

export const issuerFor = (baseUrl: string, slug: string): string => `${baseUrl}/application/o/${slug}/`;

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";
const isClusterService = (host: string) => host.endsWith(".svc") || host.endsWith(".svc.cluster.local");

// `api`: a token goes there in a header, so plain http only to this
// machine or a cluster Service, where it never leaves the cluster network.
export function apiUrlProblem(raw: string, use: "public" | "api", name: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `Enter ${name}'s address, starting with https://.`;
  }
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return `Enter ${name}'s address, starting with https://.`;
  if (use === "public" || isLocal(url.hostname) || isClusterService(url.hostname)) return null;
  return `${name}'s API must be reached over https or through its in-cluster Service, or the token would cross the network in the clear.`;
}

export const authentikUrlProblem = (raw: string, use: "public" | "api"): string | null =>
  apiUrlProblem(raw, use, "Authentik");

export function authentikClient(baseUrl: string, token: string) {
  const host = new URL(baseUrl).host;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T | null> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/v3${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new AuthentikError(`Could not reach Authentik at ${host}: ${(err as Error).message}`);
    }
    if (method === "GET" && response.status === 404) return null;
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new AuthentikError(
        `Authentik refused the token (${response.status}). Use the bootstrap token or an API token of an admin.`
      );
    }
    if (!response.ok) {
      throw new AuthentikError(`Authentik answered ${response.status} to ${method} ${path}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AuthentikError(`Authentik answered ${method} ${path} with something that is not JSON.`);
    }
  };
  const first = async <T>(path: string): Promise<T | null> => {
    const page = await call<{ results?: T[] }>("GET", path);
    return page?.results?.[0] ?? null;
  };
  return { call, first };
}

type Client = ReturnType<typeof authentikClient>;

async function flowPk(api: Client, slug: string, designation: string): Promise<string> {
  const flow =
    (await api.first<{ pk: string }>(`/flows/instances/?slug=${slug}`)) ??
    (await api.first<{ pk: string }>(`/flows/instances/?designation=${designation}&ordering=slug`));
  if (flow === null) throw new AuthentikError(`Authentik has no ${designation} flow to attach the provider to.`);
  return flow.pk;
}

async function newProvider(api: Client, target: AuthentikTarget): Promise<Provider> {
  // Listed and matched here rather than filtered with ?managed=, which
  // Authentik answers 400 for until its blueprints have created the mapping.
  const scopes =
    (
      await api.call<{ results?: Array<{ pk: string; managed: string | null }> }>(
        "GET",
        "/propertymappings/provider/scope/?page_size=100"
      )
    )?.results ?? [];
  const mappings = SCOPE_MAPPINGS.map((managed) => scopes.find((m) => m.managed === managed)?.pk);
  if (mappings.some((pk) => pk === undefined)) {
    throw new AuthentikError(
      "Authentik is still setting itself up (its default scope mappings are missing). Try again in a minute."
    );
  }
  const keys =
    (
      await api.call<{ results?: Array<{ pk: string; name: string }> }>(
        "GET",
        "/crypto/certificatekeypairs/?has_key=true"
      )
    )?.results ?? [];
  const key = keys.find((k) => k.name === SELF_SIGNED) ?? keys[0];
  const created = await api.call<Provider>("POST", "/providers/oauth2/", {
    name: target.name,
    authorization_flow: await flowPk(api, AUTHORIZATION_FLOW, "authorization"),
    invalidation_flow: await flowPk(api, INVALIDATION_FLOW, "invalidation"),
    client_type: "confidential",
    redirect_uris: [{ matching_mode: "strict", url: target.redirectUri }],
    grant_types: GRANT_TYPES,
    property_mappings: mappings,
    sub_mode: "hashed_user_id",
    issuer_mode: "per_provider",
    ...(key ? { signing_key: key.pk } : {}),
  });
  if (created === null) throw new AuthentikError("Authentik did not return the provider it created.");
  return created;
}

const hasRedirect = (provider: Provider, uri: string) =>
  (provider.redirect_uris ?? []).some(
    (r) => r.url === uri && (r.redirect_uri_type ?? "authorization") === "authorization"
  );

export async function wireAuthentik(target: AuthentikTarget): Promise<AuthentikOutcome> {
  const api = authentikClient(target.apiUrl, target.token);
  const existing = await api.call<Application>("GET", `/core/applications/${target.slug}/`);

  let provider: Provider | null = null;
  if (existing?.provider != null) {
    provider = await api.call<Provider>("GET", `/providers/oauth2/${existing.provider}/`);
  }
  // A provider by our name but no application: an earlier run stopped
  // halfway, or someone made it by hand. Reuse rather than duplicate.
  if (provider === null) {
    provider = await api.first<Provider>(`/providers/oauth2/?name=${encodeURIComponent(target.name)}`);
    if (provider !== null) provider = await api.call<Provider>("GET", `/providers/oauth2/${provider.pk}/`);
  }

  let providerState: AuthentikOutcome["provider"] = "unchanged";
  if (provider === null) {
    provider = await newProvider(api, target);
    providerState = "created";
  } else {
    const patch: Record<string, unknown> = {};
    if (!hasRedirect(provider, target.redirectUri)) {
      patch.redirect_uris = [...(provider.redirect_uris ?? []), { matching_mode: "strict", url: target.redirectUri }];
    }
    const grants = provider.grant_types ?? [];
    if (!GRANT_TYPES.every((g) => grants.includes(g))) patch.grant_types = [...new Set([...grants, ...GRANT_TYPES])];
    if (Object.keys(patch).length > 0) {
      provider = (await api.call<Provider>("PATCH", `/providers/oauth2/${provider.pk}/`, patch)) ?? provider;
      providerState = "updated";
    }
  }

  if (existing === null) {
    await api.call("POST", "/core/applications/", {
      name: target.name,
      slug: target.slug,
      provider: provider.pk,
      meta_launch_url: target.launchUrl,
    });
  } else if (existing.provider !== provider.pk) {
    await api.call("PATCH", `/core/applications/${target.slug}/`, { provider: provider.pk });
  }

  if (!provider.client_id || !provider.client_secret) {
    throw new AuthentikError(
      "Authentik did not return the provider's client ID and secret; the token may lack rights to read them."
    );
  }
  return {
    issuer: issuerFor(target.publicUrl, target.slug),
    clientId: provider.client_id,
    clientSecret: provider.client_secret,
    application: existing === null ? "created" : "found",
    provider: providerState,
  };
}
