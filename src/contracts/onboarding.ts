export type OnboardingStepId =
  "password" | "cluster" | "access" | "oidc" | "links" | "hosts" | "checks" | "notifications" | "findings";

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
  skipped: boolean;
  optional: boolean;
}

export interface OnboardingState {
  complete: boolean;
  steps: OnboardingStep[];
  findings: { unprotectedPvcs: number; unhealthyNodes: number; failingBackups: number };
}
