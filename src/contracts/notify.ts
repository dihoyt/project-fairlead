import type { Status } from "./health.js";

export type ChannelKind = "webhook" | "ntfy" | "discord" | "email";

export interface ChannelView {
  id: string;
  kind: ChannelKind;
  label: string;
  enabled: boolean;
  // Changes into a status at or above this are sent; recoveries to "ok" are
  // sent for anything that was sent going down.
  minSeverity: "warn" | "crit";
  // Non-secret settings: ntfy server and topic, the email channel's sender
  // settings. Secret parts (Discord webhook URL, ntfy token, webhook URL with
  // a token in it, SMTP password, OAuth client secret) are stored through
  // ctx.secrets and never returned.
  config: { server?: string; topic?: string; email?: EmailConfigView };
  hasSecret: boolean;
  lastSentAt?: string;
  lastError?: string;
}

export interface ChannelRequest {
  kind: ChannelKind;
  label: string;
  enabled?: boolean;
  minSeverity?: "warn" | "crit";
  config?: { server?: string; topic?: string; email?: EmailConfig };
  // Write-only. Omitted on update: keep the stored one. For email: the SMTP
  // password ("smtp" presets) or the OAuth client secret ("oauth" presets);
  // unused by "entra".
  secret?: string;
}

export interface TestSendResult {
  ok: boolean;
  // HTTP status, or the SMTP reply code.
  status?: number;
  error?: string;
  // On failure, the last thing the server said (SMTP reply line, the
  // provider's error body), secrets redacted.
  response?: string;
}

// The body a "webhook" channel POSTs.
export interface WebhookPayload {
  source: string;
  providerId: string;
  checkId: string;
  label: string;
  from: Status;
  to: Status;
  detail: string;
  at: string;
}

// --- Email ------------------------------------------------------------------
//
// One mail per status change, HTML with a plain-text part, sent one of three
// ways, picked by preset:
// - "smtp": any SMTP server with a username and (app) password.
// - "oauth" ("sign in to send"): a Google or Microsoft account signs in once
//   through an OAuth client the admin made (the same kind of client as the
//   public sign-in presets); the refresh token is sealed (scope
//   "notify:oauth", keyed by channel id) and mail is sent as that account:
//   Gmail API users.messages.send with the gmail.send scope, Microsoft Graph
//   /me/sendMail with delegated Mail.Send. Outlook.com accepts no password
//   over SMTP, so this is the way for those addresses.
// - "entra": Microsoft 365 through the Entra connector's management app,
//   app-only Graph /users/{from}/sendMail. The tenant grants that app's
//   service principal Exchange's "Application Mail.Send" role scoped to the
//   sending mailbox (RBAC for Applications); no user signs in.

export type EmailMode = "smtp" | "oauth" | "entra";

export type EmailPreset =
  | "gmail"
  | "yahoo"
  | "icloud"
  | "fastmail"
  | "sendgrid"
  | "mailgun"
  | "ses"
  | "smtp"
  | "google-oauth"
  | "microsoft-oauth"
  | "entra";

export type SmtpSecurity = "starttls" | "tls" | "none";

export type EmailOAuthProvider = "google" | "microsoft";

export interface EmailPresetInfo {
  label: string;
  mode: EmailMode;
  // Prefilled SMTP settings; the admin may change them. "ses" leaves the
  // host's region for the admin to fill.
  host?: string;
  port?: number;
  security?: SmtpSecurity;
  // A fixed SMTP username ("apikey" for SendGrid); otherwise the address.
  username?: string;
  provider?: EmailOAuthProvider;
  // One or two sentences for the form: where the password or client comes
  // from, and what the account must have turned on.
  help: string;
}

export const EMAIL_PRESETS: Readonly<Record<EmailPreset, EmailPresetInfo>> = {
  gmail: {
    label: "Gmail / Google Workspace (app password)",
    mode: "smtp",
    host: "smtp.gmail.com",
    port: 587,
    security: "starttls",
    help: "Needs 2-Step Verification on the account. Make an app password at myaccount.google.com/apppasswords; Workspace admins can turn app passwords off.",
  },
  yahoo: {
    label: "Yahoo Mail (app password)",
    mode: "smtp",
    host: "smtp.mail.yahoo.com",
    port: 465,
    security: "tls",
    help: "Account security > Generate app password.",
  },
  icloud: {
    label: "iCloud Mail (app-specific password)",
    mode: "smtp",
    host: "smtp.mail.me.com",
    port: 587,
    security: "starttls",
    help: "Needs two-factor authentication. Make an app-specific password at account.apple.com; the username is the full iCloud address.",
  },
  fastmail: {
    label: "Fastmail (app password)",
    mode: "smtp",
    host: "smtp.fastmail.com",
    port: 465,
    security: "tls",
    help: "Settings > Privacy & Security > App passwords, with SMTP access.",
  },
  sendgrid: {
    label: "SendGrid",
    mode: "smtp",
    host: "smtp.sendgrid.net",
    port: 587,
    security: "starttls",
    username: "apikey",
    help: "The password is an API key with Mail Send permission; the From address must be a verified sender.",
  },
  mailgun: {
    label: "Mailgun",
    mode: "smtp",
    host: "smtp.mailgun.org",
    port: 587,
    security: "starttls",
    help: "The SMTP credentials of your sending domain (smtp.eu.mailgun.org for EU domains).",
  },
  ses: {
    label: "Amazon SES",
    mode: "smtp",
    port: 587,
    security: "starttls",
    help: "Host email-smtp.<region>.amazonaws.com with SMTP credentials made in the SES console (not your AWS access key).",
  },
  smtp: {
    label: "Other SMTP server",
    mode: "smtp",
    port: 587,
    security: "starttls",
    help: "Any SMTP server. Leave username empty for a relay that takes mail without signing in.",
  },
  "google-oauth": {
    label: "Sign in with Google (Gmail)",
    mode: "oauth",
    provider: "google",
    help: "An OAuth web client from Google Cloud Console with the Gmail API enabled and this redirect URI. Set the consent screen to In production (or Internal for Workspace): in Testing, Google ends the sign-in after 7 days.",
  },
  "microsoft-oauth": {
    label: "Sign in with Microsoft (Outlook.com, Microsoft 365)",
    mode: "oauth",
    provider: "microsoft",
    help: "An Entra app registration for any organizational directory and personal Microsoft accounts, with this redirect URI (Web) and the delegated Mail.Send permission.",
  },
  entra: {
    label: "Microsoft 365 through the Entra connector",
    mode: "entra",
    provider: "microsoft",
    help: "No sign-in. A tenant admin gives the connector's app the Exchange role Application Mail.Send, scoped to the sending mailbox.",
  },
};

// What the form sends. Which fields apply follows the preset's mode.
export interface EmailConfig {
  preset: EmailPreset;
  // smtp
  host?: string;
  port?: number;
  security?: SmtpSecurity;
  // Empty or left out: send without SMTP AUTH.
  username?: string;
  // oauth: the client the account signs in through.
  clientId?: string;
  // The sender. smtp and entra: required. oauth: the signed-in account
  // when left out (Gmail and Graph refuse anything else unless it is an
  // alias or a mailbox the account may send as).
  from?: string;
  // At least one, at most 20.
  to: string[];
}

export interface EmailConfigView extends EmailConfig {
  mode: EmailMode;
  // oauth: the address that signed in; unset until someone has.
  account?: string;
}

// GET /api/notify/email/setup: what the email form needs beside presets.
export interface EmailSetupView {
  // <public URL>/api/notify/oauth/callback, the redirect URI an oauth
  // client must list; "" until a public URL is set.
  redirectUri: string;
  // Why "sign in to send" can't work as things stand, one sentence (no
  // public URL, SECRETS_KEY unset); unset when it can.
  oauthBlocked?: string;
  // The client sign-in already uses, when it is Google or Microsoft's,
  // so the form can offer its client id (the secret is entered again).
  signInClient?: { provider: EmailOAuthProvider; clientId: string };
  entra: EntraMailStatus;
}

// POST /api/notify/channels/:id/oauth: where to send the browser. The
// authorization request carries a single-use state (PKCE) that the
// callback checks belongs to the same user and channel; it expires after
// 10 minutes.
export interface EmailOAuthStart {
  url: string;
}

// The callback redirects the browser to the app's Notifications page with
// #/notifications?channel=<id>&oauth=ok, or &oauth=error&message=<text>.
export interface EmailOAuthCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

export interface EntraMailStatus {
  // An Entra connector is saved and can get a Graph token.
  ready: boolean;
  tenantId?: string;
  // Why not, one sentence.
  reason?: string;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

// Provided by module "connector-entra" as services "entraMail". Sends with
// an app-only token of the connector's management app; the connector's
// credential never leaves it.
export interface EntraMailService {
  status(): Promise<EntraMailStatus>;
  // Graph POST /users/{from}/sendMail. Rejects with the Graph status and
  // error message (403 ErrorAccessDenied when the mailbox is outside the
  // app's role scope).
  sendMail(from: string, message: EmailMessage, signal?: AbortSignal): Promise<void>;
}
