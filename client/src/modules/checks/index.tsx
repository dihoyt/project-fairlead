import { IconWorldCheck } from "@tabler/icons-react";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { ChecksPage } from "./ChecksPage";

export const navItems: NavItem[] = [{ label: "HTTP checks", to: "/checks", icon: IconWorldCheck, order: 45 }];

export const routes: ModuleRoute[] = [{ path: "/checks", element: <ChecksPage /> }];
