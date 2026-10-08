// Clearing the app's configuration back to defaults without a reinstall.
// Server-free on purpose: the client imports this file.

// Each scope is one box the admin can tick. Anything not ticked is left
// exactly as it is; deploy history and the cluster itself are never touched.
export const RESET_SCOPES = [
  "settings",
  "links",
  "checks",
  "hosts",
  "onboarding",
  "notifications",
  "sshKey",
  "adminPassword",
] as const;

export type ResetScope = (typeof RESET_SCOPES)[number];

export interface ResetScopeInfo {
  scope: ResetScope;
  label: string;
  help: string;
  // Ticked when the form opens. The two credentials are never preselected.
  preselected: boolean;
}

// The form's rows, in display order.
export const RESET_SCOPE_INFO: readonly ResetScopeInfo[] = [
  {
    scope: "settings",
    label: "Settings",
    help: "Every setting changed in the admin UI goes back to its environment value or default. Sign-in and public URL settings are kept.",
    preselected: true,
  },
  {
    scope: "links",
    label: "Native UI links",
    help: "Links to Rancher, Longhorn, Headlamp and the other tools shown on the category pages.",
    preselected: true,
  },
  { scope: "checks", label: "HTTP checks", help: "Every HTTP check you added or the wizard added.", preselected: true },
  {
    scope: "hosts",
    label: "Hosts",
    help: "The host inventory and the credentials stored for those hosts.",
    preselected: true,
  },
  {
    scope: "onboarding",
    label: "First-run wizard",
    help: "The wizard's done and skipped marks, so it opens again on the next page load.",
    preselected: true,
  },
  {
    scope: "notifications",
    label: "Notifications",
    help: "Channels and their stored secrets, plus queued and sent history.",
    preselected: true,
  },
  {
    scope: "sshKey",
    label: "Generated SSH key",
    help: "Deletes the install's key pair. Hosts that trust the old public key stop being reachable until the new one is installed.",
    preselected: false,
  },
  {
    scope: "adminPassword",
    label: "Built-in admin password",
    help: "Sets a new temporary password on the built-in admin account, shown once; a new one is required at its next sign-in.",
    preselected: false,
  },
];

// The word the admin types to confirm.
export const RESET_CONFIRM_WORD = "RESET";

export interface ResetRequest {
  scopes: ResetScope[];
  confirm: string;
}

export interface ResetScopeResult {
  scope: ResetScope;
  // Rows or entries removed.
  cleared: number;
}

export interface ResetResult {
  cleared: ResetScopeResult[];
  // Scopes the request left out, so the result reads as a full account.
  kept: ResetScope[];
  // Present only when adminPassword was included.
  temporaryPassword?: string;
  // True when the wizard's state was cleared: the client reopens it.
  wizardReopens: boolean;
}
