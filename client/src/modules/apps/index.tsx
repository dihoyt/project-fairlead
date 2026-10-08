import { IconApps } from "@tabler/icons-react";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { AppsPage } from "./AppsPage";

export const navItems: NavItem[] = [{ label: "Apps", to: "/apps", icon: IconApps, order: 60 }];

export const routes: ModuleRoute[] = [{ path: "/apps", element: <AppsPage /> }];
