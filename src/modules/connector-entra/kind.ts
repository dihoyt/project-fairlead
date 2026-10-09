import crypto from "node:crypto";
import type {
  ConnectorInstance,
  ConnectorKind,
  ConnectorValues,
  EntraCredential,
  OwnedStore,
} from "../../contracts/connectors.js";
import type { CheckResult, Status } from "../../contracts/health.js";
import type { DriftItem, DriftReport } from "../../contracts/ownership.js";
import type { SignInClientKey, SignInOidcView, SignInService } from "../../contracts/platform.js";
import { product } from "../../product.js";
import {
  GraphError,
  consentUrlFor,
  isCertificate,
  issuerFor,
  keyCredentialBody,
  tokenRoles,
  type GraphApplication,
  type GraphClient,
} from "./graph.js";
import {
  CERT_LIFETIME_MS,
  DAY_MS,
  ROTATE_BEFORE_MS,
  certDisplayName,
  forgetManagement,
  issueCertificate,
  loadManagement,
  managementCertificate,
  managementView,
  reconcileManagement,
  signInManagement,
  type ManagementDeps,
} from "./management.js";

export const KIND = "entra";
// The sign-in app registration, the only object the connector keeps today.
export const OWNED_KIND = "entra-app";
export const SIGNIN_KEY = "signin";
export const ACTOR = "connector-entra";

export { DAY_MS, ROTATE_BEFORE_MS } from "./management.js";
// A client secret (for tenants that refuse the sign-in app a certificate)
// lives as long as a certificate.
export const SECRET_LIFETIME_MS = CERT_LIFETIME_MS;

const MANAGE_ROLES = ["Application.ReadWrite.OwnedBy", "Application.ReadWrite.All"];
const GROUP_ROLES = ["Group.Read.All", "GroupMember.Read.All", "Directory.Read.All"];

// A sign-in certificate's public half. The private key goes to sign-in
// (services "signin") and is not kept here.
export interface SigninCert {
  // base64 DER, so the list can be PATCHed back while it is replaced.
  der: string;
  thumbprint: string;
  notAfter: string;
}

// What the connector remembers about the sign-in app in OwnedStore.
export interface SigninSpec {
  appId: string;
  displayName: string;
  redirectUri: string;
  // Unset on apps set up before certificates: "secret".
  credential?: EntraCredential;
  cert?: SigninCert;
  // A certificate replaced by rotation, removed by the next reconcile so
  // sign-in never depends on a key Entra has not finished replicating.
  previousCert?: SigninCert;
  // The client secret sign-in uses (credential "secret").
  keyId?: string;
  secretExpiresAt?: string;
  // A secret replaced by rotation or by a certificate, removed by the next
  // reconcile for the same reason.
  previousKeyId?: string;
}

export interface EntraDeps extends ManagementDeps {
  signIn(): SignInService;
  owned(instanceId: string): OwnedStore;
  // The saved instance, if any (the kind is single).
  current(): Promise<ConnectorInstance | undefined>;
}

export const credentialOf = (spec: SigninSpec): EntraCredential => spec.credential ?? "secret";

export const appDisplayName = () => `${product.displayName} sign-in`;

// Graph as the saved instance's management app, with whichever of its
// credentials works.
export async function graphFor(
  instance: ConnectorInstance,
  deps: EntraDeps,
  signal?: AbortSignal
): Promise<GraphClient> {
  const state = await loadManagement(deps, instance.id);
  return (await signInManagement(instanceValues(instance), state, deps, signal)).graph;
}

export const instanceValues = (instance: ConnectorInstance): ConnectorValues => ({
  ...instance.config,
  ...instance.secrets,
});

// Entra accepts https redirect URIs, and http only for localhost.
export function redirectProblem(redirectUri: string): string | null {
  if (!redirectUri) return "Set the public URL first (Admin > Settings), so Entra knows where to send people back.";
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return `The public URL does not make a valid redirect URI (${redirectUri}).`;
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && url.hostname === "localhost") return null;
  return (
    `The public URL is ${url.origin}, and Entra refuses http redirect URIs other than localhost. ` +
    "Serve the console over https first (the Access step's Cloudflare Tunnel or Tailscale), then set the public URL to that address."
  );
}

export function specOf(owned: OwnedStore): { externalId: string; spec: SigninSpec } | undefined {
  const row = owned.get(SIGNIN_KEY, OWNED_KIND);
  if (!row?.externalId) return undefined;
  return { externalId: row.externalId, spec: row.spec as unknown as SigninSpec };
}

export function putSpec(owned: OwnedStore, objectId: string, spec: SigninSpec): void {
  const specHash = crypto
    .createHash("sha256")
    .update(JSON.stringify([spec.appId, spec.redirectUri, spec.cert?.thumbprint ?? spec.keyId]))
    .digest("hex");
  owned.put({
    key: SIGNIN_KEY,
    kind: OWNED_KIND,
    externalId: objectId,
    spec: spec as unknown as Record<string, unknown>,
    specHash,
  });
}

// The app registration as this install wants it.
export function desiredApplication(redirectUri: string): Record<string, unknown> {
  return {
    displayName: appDisplayName(),
    signInAudience: "AzureADMyOrg",
    tags: [product.ownerMarker.externalTag],
    web: { redirectUris: redirectUri ? [redirectUri] : [] },
    // Security groups' object ids in the groups claim, for auth.oidc.adminGroups.
    groupMembershipClaims: "SecurityGroup",
    optionalClaims: { idToken: [{ name: "email", essential: false }] },
  };
}

const check = (id: string, label: string, status: Status, detail: string, now: Date, raw?: unknown): CheckResult => ({
  id,
  label,
  status,
  detail,
  observedAt: now.toISOString(),
  ...(raw === undefined ? {} : { raw }),
});

const failure = (err: unknown) =>
  err instanceof GraphError
    ? { status: err.status, code: err.code, message: err.message }
    : { message: err instanceof Error ? err.message : String(err) };

const day = (iso: string) => iso.slice(0, 10);

async function oidcOf(deps: EntraDeps): Promise<SignInOidcView | undefined> {
  try {
    return await deps.signIn().oidc();
  } catch {
    return undefined;
  }
}

function redirectCheck(oidc: SignInOidcView | undefined, now: Date): CheckResult {
  const label = "Redirect URI";
  if (!oidc) return check("redirect", label, "unknown", "Sign-in settings could not be read", now);
  const problem = redirectProblem(oidc.redirectUri);
  return problem
    ? check("redirect", label, "warn", problem, now, { redirectUri: oidc.redirectUri })
    : check("redirect", label, "ok", `Sign-in returns to ${oidc.redirectUri}`, now);
}

export async function verifyValues(
  values: ConnectorValues,
  deps: EntraDeps,
  signal: AbortSignal
): Promise<CheckResult[]> {
  const now = deps.now();
  const tenantId = (values.tenantId ?? "").trim();
  const clientId = (values.clientId ?? "").trim();
  const consent = tenantId && clientId ? consentUrlFor(tenantId, clientId, deps.endpoints) : undefined;
  const results: CheckResult[] = [];
  let roles: string[] = [];
  try {
    // A form tested after the secret was retired has no secret: the saved
    // instance's certificate stands in when the ids are the same.
    const saved = await deps.current();
    const same = saved && saved.config.tenantId === tenantId && saved.config.clientId === clientId;
    const state = same ? await loadManagement(deps, saved.id) : undefined;
    const signedIn = await signInManagement(values, state, deps, signal, true);
    roles = tokenRoles(await signedIn.graph.token(signal));
    results.push(
      check(
        "graph",
        "Microsoft Graph",
        "ok",
        `Signed in to tenant ${tenantId} as ${clientId} with its ${signedIn.credential === "certificate" ? "certificate" : "client secret"}`,
        now
      )
    );
  } catch (err) {
    results.push(
      check("graph", "Microsoft Graph", "crit", err instanceof Error ? err.message : String(err), now, failure(err))
    );
    results.push(redirectCheck(await oidcOf(deps), now));
    return results;
  }
  const manage = MANAGE_ROLES.find((r) => roles.includes(r));
  results.push(
    manage
      ? check("permission", "App registrations", "ok", `${manage} granted`, now)
      : {
          ...check(
            "permission",
            "App registrations",
            "crit",
            "Application.ReadWrite.OwnedBy is not granted to this app. Add it as an application permission and grant admin consent.",
            now,
            { roles }
          ),
          ...(consent ? { deepLink: consent } : {}),
        }
  );
  const groups = GROUP_ROLES.find((r) => roles.includes(r));
  results.push(
    groups
      ? check("groups", "Group listing", "ok", `${groups} granted: admin groups can be picked by name`, now)
      : check(
          "groups",
          "Group listing",
          "absent",
          "Group.Read.All is not granted, so admin groups are entered as object ids",
          now
        )
  );
  results.push(redirectCheck(await oidcOf(deps), now));
  return results;
}

function credentialCheck(owned: OwnedStore, oidc: SignInOidcView | undefined, now: Date): CheckResult {
  const label = "Sign-in credential";
  const mine = specOf(owned);
  if (!mine) return check("secret", label, "absent", "No sign-in app registration created yet", now);
  const certificate = credentialOf(mine.spec) === "certificate";
  const what = certificate ? "certificate" : "client secret";
  const until = (certificate ? mine.spec.cert?.notAfter : mine.spec.secretExpiresAt) ?? "";
  const expires = Date.parse(until);
  const wired = oidc?.clientId === mine.spec.appId;
  if (!wired) {
    return check(
      "secret",
      label,
      "ok",
      `Sign-in uses another client, so ${mine.spec.appId}'s ${what} (until ${day(until)}) is not replaced`,
      now
    );
  }
  if (!(expires > now.getTime()))
    return check(
      "secret",
      label,
      "crit",
      `The ${what} expired ${day(until)}; sign-in through Entra fails until the next sync replaces it`,
      now,
      { credential: what }
    );
  if (expires - now.getTime() < ROTATE_BEFORE_MS)
    return check("secret", label, "warn", `The ${what} expires ${day(until)}; the next sync replaces it`, now, {
      credential: what,
    });
  return check(
    "secret",
    label,
    "ok",
    certificate
      ? `Certificate, valid until ${day(until)}; replaced 30 days before`
      : `Client secret, valid until ${day(until)}; replaced 30 days before (the tenant refused a certificate)`,
    now
  );
}

function managementCheck(
  instance: ConnectorInstance,
  state: Awaited<ReturnType<typeof loadManagement>>,
  now: Date
): CheckResult {
  const label = "Connector credential";
  const view = managementView(instance, state);
  const link = { deepLink: "api/connector-entra/certificate" };
  if (view.step) return { ...check("management", label, "warn", view.step, now), ...(state ? link : {}) };
  if (view.credential === "secret")
    return {
      ...check(
        "management",
        label,
        "warn",
        "Signs in with the pasted client secret until the next sync moves it to a certificate",
        now
      ),
      ...link,
    };
  return check(
    "management",
    label,
    "ok",
    view.certificateExpiresAt
      ? `Certificate, valid until ${day(view.certificateExpiresAt)}; replaced 30 days before`
      : "Certificate",
    now
  );
}

async function newSecret(graph: GraphClient, objectId: string, now: Date, signal: AbortSignal) {
  return graph.addPassword(
    objectId,
    `${product.displayName} sign-in ${now.toISOString().slice(0, 10)}`,
    new Date(now.getTime() + SECRET_LIFETIME_MS).toISOString(),
    signal
  );
}

export interface SigninOutcome {
  objectId: string;
  spec: SigninSpec;
  created: boolean;
}

// A fresh credential for the sign-in app: a certificate added beside
// `keep` (the certificate sign-in uses now, so it keeps working until the
// next reconcile removes it), or a client secret when Graph refuses the
// certificate.
const signinKeyBody = (c: { der: string; thumbprint: string }) =>
  keyCredentialBody({ key: c.der, displayName: certDisplayName("sign-in", c.thumbprint) });

interface FreshCredential {
  part: Partial<SigninSpec>;
  client: { clientKey: SignInClientKey } | { clientSecret: string };
}

async function freshCredential(
  graph: GraphClient,
  objectId: string,
  keep: SigninCert | undefined,
  now: Date,
  signal: AbortSignal
): Promise<FreshCredential>;
async function freshCredential(
  graph: GraphClient,
  objectId: string,
  keep: SigninCert | undefined,
  now: Date,
  signal: AbortSignal,
  orSecret: boolean
): Promise<FreshCredential | undefined>;
async function freshCredential(
  graph: GraphClient,
  objectId: string,
  keep: SigninCert | undefined,
  now: Date,
  signal: AbortSignal,
  orSecret = true
): Promise<FreshCredential | undefined> {
  const cert = issueCertificate("sign-in", now);
  try {
    // The app is the console's own, so its key list is the console's to set.
    await graph.updateApplication(
      objectId,
      { keyCredentials: [...(keep ? [signinKeyBody(keep)] : []), signinKeyBody(cert)] },
      signal
    );
    return {
      part: {
        credential: "certificate",
        cert: { der: cert.der, thumbprint: cert.thumbprint, notAfter: cert.notAfter },
        ...(keep ? { previousCert: keep } : {}),
      },
      client: { clientKey: { privateKey: cert.privateKey, certificate: cert.certificate } },
    };
  } catch (err) {
    if (!(err instanceof GraphError) || err.status === 401 || err.status >= 500) throw err;
    if (!orSecret) return undefined;
    const password = await newSecret(graph, objectId, now, signal);
    return {
      part: { credential: "secret", keyId: password.keyId, secretExpiresAt: password.endDateTime },
      client: { clientSecret: password.secretText },
    };
  }
}

// Creates the sign-in app (or reuses the one this instance owns), puts the
// wanted redirect URI on it, gives it a fresh certificate (a client secret
// if the tenant refuses one) and points sign-in at it. The credential it
// replaces is removed on the next reconcile.
export async function setUpSignIn(
  instance: ConnectorInstance,
  deps: EntraDeps,
  options: { actor: string; adminGroups?: string[]; label?: string },
  signal: AbortSignal
): Promise<SigninOutcome> {
  const now = deps.now();
  const oidc = await deps.signIn().oidc();
  const problem = redirectProblem(oidc.redirectUri);
  if (problem) throw new SigninRefused(400, problem);
  if (oidc.blocked) throw new SigninRefused(oidc.blocked.includes("SECRETS_KEY") ? 409 : 400, oidc.blocked);

  const graph = await graphFor(instance, deps, signal);
  const owned = deps.owned(instance.id);
  const mine = specOf(owned);
  let app: GraphApplication | undefined = mine ? await graph.getApplication(mine.externalId, signal) : undefined;
  const created = app === undefined;
  if (app === undefined) {
    app = await graph.createApplication(desiredApplication(oidc.redirectUri), signal);
  } else {
    await graph.updateApplication(
      app.id,
      { web: { redirectUris: [oidc.redirectUri] }, groupMembershipClaims: "SecurityGroup" },
      signal
    );
  }
  // Recorded before anything else can fail, so the app stays owned (and
  // removable) rather than orphaned in the tenant.
  if (created)
    putSpec(owned, app.id, { appId: app.appId, displayName: app.displayName, redirectUri: oidc.redirectUri });
  const reused = mine && !created ? mine.spec : undefined;
  const keep = reused && credentialOf(reused) === "certificate" ? reused.cert : undefined;
  const { part, client } = await freshCredential(graph, app.id, keep, now, signal);
  const spec: SigninSpec = {
    appId: app.appId,
    displayName: app.displayName,
    redirectUri: oidc.redirectUri,
    ...part,
    ...(reused?.keyId ? { previousKeyId: reused.keyId } : {}),
  };
  putSpec(owned, app.id, spec);
  await deps.signIn().setOidcClient(
    {
      issuer: issuerFor(instance.config.tenantId ?? "", deps.endpoints),
      clientId: app.appId,
      ...client,
      label: options.label ?? "Sign in with Microsoft",
      enabled: true,
      ...(options.adminGroups !== undefined ? { adminGroups: options.adminGroups } : {}),
    },
    options.actor
  );
  return { objectId: app.id, spec, created };
}

export class SigninRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function reconcileSignIn(
  instance: ConnectorInstance,
  owned: OwnedStore,
  deps: EntraDeps,
  signal: AbortSignal
): Promise<DriftReport> {
  const now = deps.now();
  const items: DriftItem[] = [];
  const report = () => ({ checkedAt: now.toISOString(), items });

  items.push(...(await reconcileManagement(instance, deps, signal)));

  const mine = specOf(owned);
  // Nothing wanted until an admin sets sign-in up.
  if (!mine) return report();

  const oidc = await deps.signIn().oidc();
  const wired = oidc.clientId === mine.spec.appId;
  const redirectUri = redirectProblem(oidc.redirectUri) === null ? oidc.redirectUri : mine.spec.redirectUri;
  const graph = await graphFor(instance, deps, signal);
  const issuer = issuerFor(instance.config.tenantId ?? "", deps.endpoints);
  const base = { key: SIGNIN_KEY, kind: OWNED_KIND };

  const app = await graph.getApplication(mine.externalId, signal);
  if (!app) {
    // Deleted in the portal: recreated, and sign-in moved to it if it used the old one.
    const fresh = await graph.createApplication(desiredApplication(redirectUri), signal);
    putSpec(owned, fresh.id, { appId: fresh.appId, displayName: fresh.displayName, redirectUri });
    const { part, client } = await freshCredential(graph, fresh.id, undefined, now, signal);
    putSpec(owned, fresh.id, { appId: fresh.appId, displayName: fresh.displayName, redirectUri, ...part });
    if (wired) await deps.signIn().setOidcClient({ issuer, clientId: fresh.appId, ...client }, ACTOR);
    items.push({
      ...base,
      externalId: fresh.id,
      state: "missing",
      diff: [{ path: "appId", want: mine.spec.appId, have: fresh.appId }],
    });
    return report();
  }

  const diff: Array<{ path: string; want: unknown; have: unknown }> = [];
  const patch: Record<string, unknown> = {};
  const haveUris = app.web?.redirectUris ?? [];
  if (redirectUri && (haveUris.length !== 1 || haveUris[0] !== redirectUri)) {
    patch.web = { redirectUris: [redirectUri] };
    diff.push({ path: "web.redirectUris", want: [redirectUri], have: haveUris });
  }
  if (app.groupMembershipClaims !== "SecurityGroup") {
    patch.groupMembershipClaims = "SecurityGroup";
    diff.push({ path: "groupMembershipClaims", want: "SecurityGroup", have: app.groupMembershipClaims ?? null });
  }
  if (Object.keys(patch).length > 0) await graph.updateApplication(app.id, patch, signal);

  let spec: SigninSpec = { ...mine.spec, redirectUri, displayName: app.displayName };
  const keyIds = new Set((app.passwordCredentials ?? []).map((p) => p.keyId));
  const certs = app.keyCredentials ?? [];
  const has = (cert: SigninCert | undefined) =>
    cert !== undefined && certs.some((k) => isCertificate(k, cert.thumbprint));

  if (spec.previousKeyId) {
    if (keyIds.has(spec.previousKeyId)) await graph.removePassword(app.id, spec.previousKeyId, signal);
    const { previousKeyId: _removed, ...rest } = spec;
    spec = rest;
  }
  if (spec.previousCert) {
    if (has(spec.previousCert)) {
      const current = spec.cert && has(spec.cert) ? [spec.cert] : [];
      await graph.updateApplication(
        app.id,
        {
          keyCredentials: current.map(signinKeyBody),
        },
        signal
      );
    }
    const { previousCert: _removed, ...rest } = spec;
    spec = rest;
  }

  const certificate = credentialOf(spec) === "certificate";
  const gone = certificate ? !has(spec.cert) : !spec.keyId || !keyIds.has(spec.keyId);
  const until = (certificate ? spec.cert?.notAfter : spec.secretExpiresAt) ?? "";
  const expiring = !(Date.parse(until) - now.getTime() >= ROTATE_BEFORE_MS);
  // Apps on a secret move to a certificate when the tenant takes one; the
  // secret stays (and is rotated as before) when it does not.
  const due = gone || expiring;
  const fresh =
    wired && (due || !certificate)
      ? await freshCredential(graph, app.id, certificate && !gone ? spec.cert : undefined, now, signal, due)
      : undefined;
  if (fresh) {
    const switched = fresh.part.credential === "certificate" && !certificate;
    const replacedSecret = !certificate && !gone ? spec.keyId : undefined;
    const { cert: _c, previousCert: _p, keyId: _k, secretExpiresAt: _s, credential: _cr, ...rest } = spec;
    spec = { ...rest, ...fresh.part, ...(replacedSecret ? { previousKeyId: replacedSecret } : {}) };
    putSpec(owned, app.id, spec);
    await deps.signIn().setOidcClient({ issuer, clientId: app.appId, ...fresh.client }, ACTOR);
    diff.push(
      switched
        ? { path: "credential", want: "certificate", have: "client secret" }
        : {
            path: certificate ? "certificate" : "secret",
            want: `valid for more than ${ROTATE_BEFORE_MS / DAY_MS} days`,
            have: gone ? "removed outside this install" : `expires ${day(until)}`,
          }
    );
  } else {
    putSpec(owned, app.id, spec);
  }

  items.push({
    ...base,
    externalId: app.id,
    state: diff.length > 0 ? "drifted" : "in-sync",
    ...(diff.length ? { diff } : {}),
  });
  return report();
}

export function createEntraKind(deps: EntraDeps): ConnectorKind {
  const verify = async (values: ConnectorValues, signal: AbortSignal): Promise<CheckResult[]> => {
    try {
      return await verifyValues(values, deps, signal);
    } catch (err) {
      return [
        check(
          "graph",
          "Microsoft Graph",
          "crit",
          err instanceof Error ? err.message : String(err),
          deps.now(),
          failure(err)
        ),
      ];
    }
  };
  return {
    kind: KIND,
    label: "Microsoft Entra ID",
    description:
      "Creates the app registration this install signs in through and keeps its certificate current. " +
      "Needs an app registration with Microsoft Graph's Application.ReadWrite.OwnedBy application permission " +
      "(and Group.Read.All to pick admin groups), admin consented. Its client secret is only used until the " +
      "console's own certificate is on the app.",
    capabilities: ["identity"],
    fields: [
      {
        key: "tenantId",
        label: "Tenant ID",
        type: "text",
        required: true,
        placeholder: "00000000-0000-0000-0000-000000000000",
        help: "Directory (tenant) ID, from the management app's Overview page.",
      },
      {
        key: "clientId",
        label: "Client ID",
        type: "text",
        required: true,
        help: "Application (client) ID of the management app registration, not the sign-in app.",
      },
      {
        key: "objectId",
        label: "Object ID",
        type: "text",
        required: false,
        placeholder: "00000000-0000-0000-0000-000000000000",
        help: "Object ID of the management app, from its Overview page. Lets the console replace its own certificate before it expires.",
      },
      {
        key: "clientSecret",
        label: "Client secret",
        type: "secret",
        required: false,
        help: "A client secret's value from Certificates & secrets. Used once: the console moves to a certificate and the secret is deleted.",
      },
    ],
    single: true,
    docsUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    verify,
    async health(instance, signal) {
      const results = await verify(instanceValues(instance), signal);
      const now = deps.now();
      results.push(managementCheck(instance, await loadManagement(deps, instance.id), now));
      results.push(credentialCheck(deps.owned(instance.id), await oidcOf(deps), now));
      return results;
    },
    reconcile: (instance, owned, signal) => reconcileSignIn(instance, owned, deps, signal),
    async cleanup(instance, owned) {
      let removed = 0;
      const errors: string[] = [];
      let graph: GraphClient;
      try {
        graph = await graphFor(instance, deps);
      } catch (err) {
        return { removed, errors: [`Microsoft Graph: ${err instanceof Error ? err.message : String(err)}`] };
      }
      for (const row of owned.list(OWNED_KIND)) {
        try {
          if (row.externalId) await graph.deleteApplication(row.externalId);
          owned.delete(row.key, row.kind);
          removed++;
        } catch (err) {
          errors.push(
            `App registration ${String(row.spec.appId ?? row.externalId)}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      // The certificate stays on the management app, which the admin
      // removes with it; the private key goes with the connector.
      if (errors.length === 0) await forgetManagement(deps, instance.id);
      return { removed, errors };
    },
  };
}

export { managementCertificate };
