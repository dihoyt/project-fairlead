import type { EmailConfigView, EntraMailService, WebhookPayload } from "../../contracts/notify.js";
import type { SecretStore } from "../../contracts/index.js";
import type { DeliveryResult } from "./channels.js";
import {
  SendError,
  compose,
  emailMode,
  providerOf,
  redact,
  sendEntra,
  sendOAuth,
  sendSmtp,
  sender,
  tokenRequest,
  type OAuthEndpoints,
  type SendResult,
} from "./email.js";

// Refresh tokens live apart from the password / client secret, so editing a
// channel's client secret never loses the sign-in and vice versa.
export const OAUTH_SCOPE = "notify:oauth";

const TOKEN_MARGIN_MS = 60_000;

export interface MailerDeps {
  secrets: SecretStore;
  endpoints: OAuthEndpoints;
  entra: () => EntraMailService | undefined;
  // The console's public URL for the link in each mail; "" for none.
  consoleUrl: () => string;
  now?: () => number;
}

export function createMailer(deps: MailerDeps) {
  const now = deps.now ?? Date.now;
  // Per pod; a pod without one signs in again with the refresh token.
  const accessTokens = new Map<string, { token: string; expires: number; key: string }>();

  async function accessToken(
    channelId: string,
    config: EmailConfigView,
    clientSecret: string | null,
    signal?: AbortSignal
  ) {
    const provider = providerOf(config);
    const refresh = await deps.secrets.get(OAUTH_SCOPE, channelId);
    if (!refresh) throw new SendError("Nobody has signed in to send from this channel yet. Edit it and sign in.");
    if (!config.clientId || !clientSecret) throw new SendError("The channel has no OAuth client id or secret.");
    const key = `${config.clientId}|${refresh}`;
    const cached = accessTokens.get(channelId);
    if (cached && cached.key === key && cached.expires > now() + TOKEN_MARGIN_MS) return cached.token;
    const tokens = await tokenRequest(
      provider,
      {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: config.clientId,
        client_secret: clientSecret,
      },
      deps.endpoints,
      signal
    );
    let current = refresh;
    if (tokens.refreshToken && tokens.refreshToken !== refresh) {
      await deps.secrets.put(OAUTH_SCOPE, channelId, tokens.refreshToken);
      current = tokens.refreshToken;
    }
    // Access tokens from both providers last an hour; the exact lifetime
    // isn't needed with this margin.
    accessTokens.set(channelId, {
      token: tokens.accessToken,
      expires: now() + 50 * 60_000,
      key: `${config.clientId}|${current}`,
    });
    return tokens.accessToken;
  }

  return {
    forget(channelId: string) {
      accessTokens.delete(channelId);
    },

    async send(
      channelId: string,
      config: EmailConfigView | undefined,
      payload: WebhookPayload,
      signal?: AbortSignal
    ): Promise<DeliveryResult> {
      if (!config) return { ok: false, error: "The channel has no email settings." };
      const secret = await deps.secrets.get("notify", channelId);
      const refresh = await deps.secrets.get(OAUTH_SCOPE, channelId);
      if (emailMode(config) === "oauth" && !refresh) {
        return { ok: false, error: "Nobody has signed in to send from this channel yet. Edit it and sign in." };
      }
      const from = sender(config);
      if (!from) return { ok: false, error: "No sender address is set." };
      const message = compose(payload, config.to, deps.consoleUrl());
      try {
        let result: SendResult;
        switch (emailMode(config)) {
          case "smtp":
            result = await sendSmtp(config, secret, from, message);
            break;
          case "oauth":
            result = await sendOAuth(
              providerOf(config),
              await accessToken(channelId, config, secret, signal),
              from,
              message,
              deps.endpoints,
              signal
            );
            break;
          case "entra": {
            const entra = deps.entra();
            if (!entra) throw new SendError("The Microsoft Entra ID connector is not loaded.");
            result = await sendEntra(entra, from, message, signal);
            break;
          }
        }
        return { ok: true, ...(result.status ? { status: result.status } : {}) };
      } catch (err) {
        // A refused token may be a revoked sign-in; the next send asks again.
        if (err instanceof SendError && (err.status === 401 || err.status === 400)) accessTokens.delete(channelId);
        const hide = [secret, refresh, accessTokens.get(channelId)?.token];
        const status = err instanceof SendError ? err.status : undefined;
        const response =
          err instanceof SendError && err.response ? redact(err.response, hide).slice(0, 500) : undefined;
        return {
          ok: false,
          ...(status ? { status } : {}),
          error: redact(err instanceof Error ? err.message : String(err), hide),
          ...(response ? { response } : {}),
        };
      }
    },
  };
}

export type Mailer = ReturnType<typeof createMailer>;
