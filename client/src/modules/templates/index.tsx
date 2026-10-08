import { IconTemplate } from "@tabler/icons-react";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { TemplatesPage } from "./TemplatesPage";

export const navItems: NavItem[] = [{ label: "Templates", to: "/templates", icon: IconTemplate, order: 65 }];

export const routes: ModuleRoute[] = [{ path: "/templates", element: <TemplatesPage /> }];
