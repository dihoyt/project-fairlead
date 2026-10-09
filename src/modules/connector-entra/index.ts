import type { ConnectorInstance, EntraSignInView } from "../../contracts/connectors.js";
import type { Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { GRAPH_BASE, GraphError, LOGIN_BASE, consentUrlFor, type GraphEndpoints } from "./graph.js";
import {
  KIND,
  SigninRefused,
  createEntraKind,
  graphFor,
  instanceValues,
  redirectProblem,
  setUpSignIn,
  specOf,
  type EntraDeps,
} from "./kind.js";
import { migrations } from "./migrations.js";

export interface EntraModuleOptions {
  // Tests point these at a fake Graph.
  endpoints?: GraphEndpoints;
  now?: () => Date;
}

const asList = (raw: unknown): string[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new HttpError(400, "Admin groups must be a list of group object ids.");
  return [...new Set(raw.map((g) => String(g).trim()).filter(Boolean))];
};

const graphFailure = (err: unknown): never => {
  if (err instanceof SigninRefused) throw new HttpError(err.status, err.message);
  if (err instanceof GraphError) throw new HttpError(502, err.message);
  throw err;
};

export function register(ctx: ModuleContext, options: EntraModuleOptions = {}): void {
  const deps: EntraDeps = {
    endpoints: options.endpoints ?? { login: LOGIN_BASE, graph: GRAPH_BASE },
    signIn: () => ctx.services.get("signin"),
    owned: (id) => ctx.services.get("connectors").owned(id),
    now: options.now ?? (() => new Date()),
  };
  ctx.services.get("connectors").addKind(createEntraKind(deps));

  const current = async (): Promise<ConnectorInstance | undefined> =>
    (await ctx.services.get("connectors").instances(KIND))[0];

  ctx.services.provide("entraMail", {
    async status() {
      const instance = await current();
      if (!instance)
        return { ready: false, reason: "Add the Microsoft Entra ID connector first (Admin > Connectors)." };
      const values = instanceValues(instance);
      const tenantId = (values.tenantId ?? "").trim();
      if (!tenantId || !values.clientId || !values.clientSecret) {
        return {
          ready: false,
          ...(tenantId ? { tenantId } : {}),
          reason: "The Entra connector has no management app credentials saved.",
        };
      }
      return { ready: true, tenantId };
    },
    async sendMail(from, message, signal) {
      const instance = await current();
      if (!instance) throw new Error("Add the Microsoft Entra ID connector first (Admin > Connectors).");
      await graphFor(instanceValues(instance), deps).sendMail(from, message, signal);
    },
  });

  const mustHave = async (): Promise<ConnectorInstance> => {
    const instance = await current();
    if (!instance) throw new HttpError(409, "Add the Microsoft Entra ID connector first (Admin > Connectors).");
    return instance;
  };

  async function view(signal?: AbortSignal): Promise<EntraSignInView> {
    const oidc = await deps.signIn().oidc();
    const instance = await current();
    const problem = redirectProblem(oidc.redirectUri);
    if (!instance) return { redirectUri: oidc.redirectUri, wired: false, ...(problem ? { warning: problem } : {}) };

    const tenantId = instance.config.tenantId ?? "";
    const out: EntraSignInView = {
      connectorId: instance.id,
      tenantId,
      redirectUri: oidc.redirectUri,
      wired: false,
      consentUrl: consentUrlFor(tenantId, instance.config.clientId ?? "", deps.endpoints),
      ...(problem ? { warning: problem } : {}),
    };
    const mine = specOf(deps.owned(instance.id));
    if (!mine) return out;
    out.wired = oidc.clientId === mine.spec.appId;
    let state: NonNullable<EntraSignInView["app"]>["state"] = "in-sync";
    let redirectUris = [mine.spec.redirectUri];
    try {
      const app = await graphFor(instanceValues(instance), deps).getApplication(mine.externalId, signal);
      if (!app) state = "missing";
      else {
        redirectUris = app.web?.redirectUris ?? [];
        const keyIds = (app.passwordCredentials ?? []).map((p) => p.keyId);
        const uriOk =
          !oidc.redirectUri || problem !== null || (redirectUris.length === 1 && redirectUris[0] === oidc.redirectUri);
        if (!uriOk || !keyIds.includes(mine.spec.keyId)) state = "drifted";
      }
    } catch (err) {
      if (!out.warning) out.warning = `Entra could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
    out.app = {
      appId: mine.spec.appId,
      objectId: mine.externalId,
      displayName: mine.spec.displayName,
      redirectUris,
      secretExpiresAt: mine.spec.secretExpiresAt,
      state,
    };
    return out;
  }

  ctx.route("GET /api/connector-entra/view", async () => view());

  ctx.route("POST /api/connector-entra/signin", async (req, res) => {
    const user = ctx.require(req, res, "admin");
    if (!user) return undefined;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const adminGroups = asList(body.adminGroups);
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined;
    const instance = await mustHave();
    let outcome;
    try {
      outcome = await setUpSignIn(
        instance,
        deps,
        { actor: user.id, ...(adminGroups !== undefined ? { adminGroups } : {}), ...(label ? { label } : {}) },
        AbortSignal.timeout(60_000)
      );
    } catch (err) {
      return graphFailure(err);
    }
    ctx.audit.record({
      actor: user.id,
      action: "connector-entra.signin",
      target: outcome.spec.appId,
      detail: `${outcome.created ? "created" : "reused"} app registration; redirect ${outcome.spec.redirectUri}`,
    });
    return view();
  });

  ctx.route("GET /api/connector-entra/groups", async (req, res) => {
    if (!ctx.require(req, res, "admin")) return undefined;
    const instance = await mustHave();
    const search = typeof req.query.search === "string" ? req.query.search : "";
    try {
      return await graphFor(instanceValues(instance), deps).groups(search);
    } catch (err) {
      return graphFailure(err);
    }
  });
}

const mod: Module = {
  id: "connector-entra",
  milestone: "B",
  migrations,
  register: (ctx) => register(ctx),
};

export default mod;
