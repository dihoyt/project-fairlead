import { IconApps, IconRocket } from "@tabler/icons-react";
import { Navigate } from "react-router";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { DeployPage } from "./DeployPage";
import { InstalledPage } from "./InstalledPage";

export const navItems: NavItem[] = [
  { label: "Installed", to: "/apps/installed", icon: IconApps, order: 60, group: "Apps" },
  { label: "Deploy", to: "/apps/deploy", icon: IconRocket, order: 61, group: "Apps" },
];

export const routes: ModuleRoute[] = [
  { path: "/apps", element: <Navigate to="/apps/installed" replace /> },
  { path: "/apps/installed", element: <InstalledPage /> },
  { path: "/apps/deploy", element: <DeployPage /> },
  { path: "/apps/deploy/:tab", element: <DeployPage /> },
];
