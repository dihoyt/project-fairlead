import { IconDatabase } from "@tabler/icons-react";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { PosturePage } from "./PosturePage";

export const navItems: NavItem[] = [{ label: "Backups", to: "/backups", icon: IconDatabase, order: 20 }];

export const routes: ModuleRoute[] = [{ path: "/backups", element: <PosturePage /> }];
