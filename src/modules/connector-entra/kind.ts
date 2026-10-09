import crypto from "node:crypto";
import type { ConnectorInstance, ConnectorKind, ConnectorValues, OwnedStore } from "../../contracts/connectors.js";
import type { CheckResult, Status } from "../../contracts/health.js";
import type { DriftItem, DriftReport } from "../../contracts/ownership.js";
import type { SignInOidcView, SignInService } from "../../contracts/platform.js";
import { product } from "../../product.js";
import {
  GraphError,
  consentUrlFor,
  createGraphClient,
  issuerFor,
  tokenRoles,
  type GraphApplication,
  type GraphClient,
  type GraphEndpoints,
} from "./graph.js";

export const KIND = "entra";
// The sign-in app registration, the only object the connector keeps today.
export const OWNED_KIND = "entra-app";
export const SIGNIN_KEY = "signin";
export const ACTOR = "connector-entra";

export const DAY_MS = 24 * 60 * 60 * 1000;
// A client secret lives this long; it is replaced once it has less than
// ROTATE_BEFORE_MS left.
export const SECRET_LIFETIME_MS = 365 * DAY_MS;
export const ROTATE_BEFORE_MS = 30 * DAY_MS;

const MANAGE_ROLES = ["Application.ReadWrite.OwnedBy", "Application.ReadWrite.All"];
const GROUP_ROLES = ["Group.Read.All", "GroupMember.Read.All", "Directory.Read.All"];

// What the connector remembers about the sign-in app in OwnedStore.
export interface SigninSpec {
  appId: string;
  displayName: string;
  redirectUri: string;
  // The client secret sign-in uses.
  keyId: string;
  secretExpiresAt: string;
  // A secret replaced by rotation, removed by the next reconcile so sign-in
  // never holds a secret Entra has not finished replicating.
  previousKeyId?: string;
}

export interface EntraDeps {
  endpoints: GraphEndpoints;
  signIn(): SignInService;
  owned(instanceId: string): OwnedStore;
  now(): Date;
}

export const appDisplayName = () => `${product.displayName} sign-in`;

export function graphFor(values: ConnectorValues, deps: Pick<EntraDeps, "endpoints">): GraphClient {
  return createGraphClient(
    {
      tenantId: (values.tenantId ?? "").trim(),
      clientId: (values.clientId ?? "").trim(),
      clientSecret: values.clientSecret ?? "",
    },
    deps.endpoints
  );
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
    .update(JSON.stringify([spec.appId, spec.redirectUri, spec.keyId]))
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
    roles = tokenRoles(await graphFor(values, deps).token(signal, true));
    results.push(check("graph", "Microsoft Graph", "ok", `Signed in to tenant ${tenantId} as ${clientId}`, now));
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

function secretCheck(owned: OwnedStore, oidc: SignInOidcView | undefined, now: Date): CheckResult {
  const label = "Sign-in client secret";
  const mine = specOf(owned);
  if (!mine) return check("secret", label, "absent", "No sign-in app registration created yet", now);
  const expires = Date.parse(mine.spec.secretExpiresAt);
  const wired = oidc?.clientId === mine.spec.appId;
  if (!wired) {
    return check(
      "secret",
      label,
      "ok",
      `Sign-in uses another client, so ${mine.spec.appId}'s secret (until ${day(mine.spec.secretExpiresAt)}) is not rotated`,
      now
    );
  }
  if (expires <= now.getTime())
    return check(
      "secret",
      label,
      "crit",
      `Expired ${day(mine.spec.secretExpiresAt)}; sign-in through Entra fails until it is rotated`,
      now,
      {
        keyId: mine.spec.keyId,
      }
    );
  if (expires - now.getTime() < ROTATE_BEFORE_MS)
    return check("secret", label, "warn", `Expires ${day(mine.spec.secretExpiresAt)}; the next sync rotates it`, now, {
      keyId: mine.spec.keyId,
    });
  return check("secret", label, "ok", `Valid until ${day(mine.spec.secretExpiresAt)}; rotated 30 days before`, now);
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

// Creates the sign-in app (or reuses the one this instance owns), puts the
// wanted redirect URI on it, makes a client secret and points sign-in at
// it. Old secrets this install made are removed on the next reconcile.
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

  const graph = graphFor(instanceValues(instance), deps);
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
  const password = await newSecret(graph, app.id, now, signal);
  const spec: SigninSpec = {
    appId: app.appId,
    displayName: app.displayName,
    redirectUri: oidc.redirectUri,
    keyId: password.keyId,
    secretExpiresAt: password.endDateTime,
    ...(mine && !created ? { previousKeyId: mine.spec.keyId } : {}),
  };
  // Recorded before sign-in changes, so a failure below still leaves the
  // app owned (and removable) rather than orphaned in the tenant.
  putSpec(owned, app.id, spec);
  await deps.signIn().setOidcClient(
    {
      issuer: issuerFor(instance.config.tenantId ?? "", deps.endpoints),
      clientId: app.appId,
      clientSecret: password.secretText,
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
  const mine = specOf(owned);
  // Nothing wanted until an admin sets sign-in up.
  if (!mine) return report();

  const oidc = await deps.signIn().oidc();
  const wired = oidc.clientId === mine.spec.appId;
  const redirectUri = redirectProblem(oidc.redirectUri) === null ? oidc.redirectUri : mine.spec.redirectUri;
  const graph = graphFor(instanceValues(instance), deps);
  const issuer = issuerFor(instance.config.tenantId ?? "", deps.endpoints);
  const base = { key: SIGNIN_KEY, kind: OWNED_KIND };

  const app = await graph.getApplication(mine.externalId, signal);
  if (!app) {
    // Deleted in the portal: recreated, and sign-in moved to it if it used the old one.
    const fresh = await graph.createApplication(desiredApplication(redirectUri), signal);
    const password = await newSecret(graph, fresh.id, now, signal);
    putSpec(owned, fresh.id, {
      appId: fresh.appId,
      displayName: fresh.displayName,
      redirectUri,
      keyId: password.keyId,
      secretExpiresAt: password.endDateTime,
    });
    if (wired) {
      await deps.signIn().setOidcClient({ issuer, clientId: fresh.appId, clientSecret: password.secretText }, ACTOR);
    }
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

  if (spec.previousKeyId) {
    if (keyIds.has(spec.previousKeyId)) await graph.removePassword(app.id, spec.previousKeyId, signal);
    const { previousKeyId: _removed, ...rest } = spec;
    spec = rest;
  }

  const secretGone = !keyIds.has(spec.keyId);
  const expiring = Date.parse(spec.secretExpiresAt) - now.getTime() < ROTATE_BEFORE_MS;
  if (wired && (secretGone || expiring)) {
    const password = await newSecret(graph, app.id, now, signal);
    const previous = spec.keyId;
    spec = {
      ...spec,
      keyId: password.keyId,
      secretExpiresAt: password.endDateTime,
      ...(secretGone ? {} : { previousKeyId: previous }),
    };
    putSpec(owned, app.id, spec);
    await deps.signIn().setOidcClient({ issuer, clientId: app.appId, clientSecret: password.secretText }, ACTOR);
    diff.push({
      path: "secret",
      want: `valid for more than ${ROTATE_BEFORE_MS / DAY_MS} days`,
      have: secretGone ? "removed outside this install" : `expires ${day(mine.spec.secretExpiresAt)}`,
    });
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
      "Creates and rotates the app registration this install signs in through. " +
      "Needs an app registration with Microsoft Graph's Application.ReadWrite.OwnedBy application permission " +
      "(and Group.Read.All to pick admin groups), admin consented.",
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
        key: "clientSecret",
        label: "Client secret",
        type: "secret",
        required: true,
        help: "A client secret's value from Certificates & secrets.",
      },
    ],
    single: true,
    docsUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    verify,
    async health(instance, signal) {
      const results = await verify(instanceValues(instance), signal);
      results.push(secretCheck(deps.owned(instance.id), await oidcOf(deps), deps.now()));
      return results;
    },
    reconcile: (instance, owned, signal) => reconcileSignIn(instance, owned, deps, signal),
    async cleanup(instance, owned) {
      const graph = graphFor(instanceValues(instance), deps);
      let removed = 0;
      const errors: string[] = [];
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
      return { removed, errors };
    },
  };
}
