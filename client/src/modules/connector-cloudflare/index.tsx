import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { CloudflarePage } from "./CloudflarePage";

// Reached from the connector's card and the Access step, not the menu.
export const navItems: NavItem[] = [];

export const routes: ModuleRoute[] = [{ path: "/admin/cloudflare", element: <CloudflarePage /> }];
