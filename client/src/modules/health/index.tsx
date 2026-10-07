import { IconHeartbeat } from "@tabler/icons-react";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { Board } from "./Board";
import { CategoryPage } from "./CategoryPage";

export const navItems: NavItem[] = [{ label: "Health", to: "/health", icon: IconHeartbeat, order: 10 }];

export const routes: ModuleRoute[] = [
  { path: "/health", element: <Board /> },
  { path: "/health/:category", element: <CategoryPage /> },
];
