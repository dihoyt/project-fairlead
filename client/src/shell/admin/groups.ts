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
  fleet: "Fleet",
  health: "Health board",
  hosts: "Hosts",
  k8s: "Kubernetes access",
  longhorn: "Longhorn",
  notify: "Notifications",
  velero: "Velero",
  workloads: "Workloads",
};

export function groupTitle(group: string): string {
  return GROUP_TITLES[group] ?? group.charAt(0).toUpperCase() + group.slice(1);
}
