import type { SignInOidcClient, SignInService } from "../contracts/platform.js";
import { CALLBACK_PATH, OIDC_SECRET } from "./auth/oidc.js";
import { publicOrigin, type Core } from "./core.js";
import { secretKeyConfigured } from "./secretBox.js";

export class SignInError extends Error {
  // 409 when the install itself is missing something (SECRETS_KEY), 400 otherwise.
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const settingFor: Record<Exclude<keyof SignInOidcClient, "clientSecret">, string> = {
  issuer: "auth.oidc.issuer",
  clientId: "auth.oidc.clientId",
  label: "auth.oidc.label",
  adminGroups: "auth.oidc.adminGroups",
  scopes: "auth.oidc.scopes",
  enabled: "auth.oidc.enabled",
};

// The one write path for "sign in through this provider": the Authentik
// wiring route and connector modules (services "signin") both end here.
export function createSignIn(core: Core): SignInService & {
  blocked(keys: readonly string[]): SignInError | null;
} {
  const blocked = (keys: readonly string[]): SignInError | null => {
    if (!publicOrigin(core))
      return new SignInError(400, "Set the public URL first, so the provider knows where to send people back.");
    if (!secretKeyConfigured())
      return new SignInError(409, "SECRETS_KEY is not set, so the client secret cannot be stored.");
    const locked = core.settings.describe().find((view) => keys.includes(view.key) && view.locked);
    if (locked)
      return new SignInError(
        400,
        `${locked.label} is set by the environment (${locked.env}); unset it to change sign-in here.`
      );
    return null;
  };

  return {
    blocked,
    async oidc() {
      const origin = publicOrigin(core);
      return {
        enabled: core.settings.bool("auth.oidc.enabled"),
        issuer: core.settings.string("auth.oidc.issuer"),
        clientId: core.settings.string("auth.oidc.clientId"),
        hasSecret: await core.secrets.has(OIDC_SECRET.scope, OIDC_SECRET.id),
        redirectUri: origin ? `${origin}${CALLBACK_PATH}` : "",
        // Scopes are written only by a provider that needs more than the
        // default, so OIDC_SCOPES set in the environment blocks only that one.
        blocked: blocked(Object.values(settingFor).filter((key) => key !== settingFor.scopes))?.message ?? null,
      };
    },
    async setOidcClient(client, actor) {
      const values: Array<[string, unknown]> = [];
      for (const [field, key] of Object.entries(settingFor) as Array<[keyof typeof settingFor, string]>) {
        if (client[field] !== undefined) values.push([key, client[field]]);
      }
      const refused = blocked(values.map(([key]) => key));
      if (refused) throw refused;
      await core.secrets.putAs(OIDC_SECRET.scope, OIDC_SECRET.id, client.clientSecret, actor);
      for (const [key, value] of values) core.settings.set(key, value, actor);
      core.audit.record({
        actor,
        action: "auth.oidc.wire",
        target: client.issuer,
        detail: `clientId=${client.clientId} settings=${values.map(([key]) => key).join(",")}`,
        result: "ok",
      });
    },
  };
}
