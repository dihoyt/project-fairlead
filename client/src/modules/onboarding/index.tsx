import { IconRocket } from "@tabler/icons-react";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { apiRequest } from "../../ui/api";
import { seedNeedsAttention } from "./SeedSummary";
import { WelcomePage } from "./WelcomePage";

export const navItems: NavItem[] = [{ label: "Setup", to: "/welcome", icon: IconRocket, order: 90, section: "admin" }];

export const routes: ModuleRoute[] = [{ path: "/welcome", element: <WelcomePage /> }];

export const firstRun = {
  path: "/welcome",
  isPending: async () =>
    !(await apiRequest("GET /api/onboarding/state")).complete ||
    seedNeedsAttention(await apiRequest("GET /api/onboarding/seed")),
};
