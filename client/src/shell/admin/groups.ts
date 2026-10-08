// Setting groups the sign-in page shows; every other group is on the
// settings page, so a setting the platform adds is never left unshown.
export const SIGN_IN_GROUPS = ["Password sign-in", "OIDC sign-in", "Sessions"] as const;

export function isSignInGroup(group: string): boolean {
  return (SIGN_IN_GROUPS as readonly string[]).includes(group);
}

// A module's settings are grouped under its id; these are the headings shown for them.
const GROUP_TITLES: Record<string, string> = {
  backups: "Backups",
  cluster: "Cluster",
  "connector-cloudflare": "Cloudflare",
  deploy: "Apps",
  fleet: "Fleet",
  health: "Health board",
  hosts: "Hosts",
  k8s: "Kubernetes access",
  longhorn: "Longhorn",
  mcp: "MCP",
  notify: "Notifications",
  velero: "Velero",
  workloads: "Workloads",
};

export function groupTitle(group: string): string {
  return GROUP_TITLES[group] ?? group.charAt(0).toUpperCase() + group.slice(1);
}

// Settings edited on the page they belong to; this page links there instead.
export const EDITED_ELSEWHERE: Record<string, { page: string; href: string }> = {
  "connector-cloudflare.accessApps": { page: "Cloudflare", href: "#/admin/cloudflare" },
};

export type SettingsSection = "general" | "sign-in" | "access" | "monitoring" | "notifications" | "advanced";

export const SECTIONS: Array<{ id: SettingsSection; title: string }> = [
  { id: "general", title: "General" },
  { id: "sign-in", title: "Sign-in" },
  { id: "access", title: "Access" },
  { id: "monitoring", title: "Monitoring" },
  { id: "notifications", title: "Notifications" },
  { id: "advanced", title: "Advanced" },
];

const SECTION_OF: Record<string, SettingsSection> = {
  General: "general",
  health: "general",
  deploy: "access",
  "connector-cloudflare": "access",
  mcp: "access",
  backups: "monitoring",
  cluster: "monitoring",
  fleet: "monitoring",
  hosts: "monitoring",
  longhorn: "monitoring",
  velero: "monitoring",
  workloads: "monitoring",
  notify: "notifications",
};

// A group no section claims lands in Advanced, so a new module's settings still show.
export function sectionOf(group: string): SettingsSection {
  return SECTION_OF[group] ?? "advanced";
}
