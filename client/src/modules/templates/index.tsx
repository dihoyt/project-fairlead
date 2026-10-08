import { Navigate } from "react-router";
import type { ModuleRoute, NavItem } from "../../ui/contracts";

// Templates live on Apps > Deploy now; the old address still lands there.
export const navItems: NavItem[] = [];

export const routes: ModuleRoute[] = [
  { path: "/templates", element: <Navigate to="/apps/deploy/templates" replace /> },
];
