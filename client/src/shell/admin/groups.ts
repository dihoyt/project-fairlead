// Setting groups the sign-in page shows; every other group is on the
// settings page, so a setting the platform adds is never left unshown.
export const SIGN_IN_GROUPS = ["Password sign-in", "OIDC sign-in", "Sessions"] as const;

export function isSignInGroup(group: string): boolean {
  return (SIGN_IN_GROUPS as readonly string[]).includes(group);
}
