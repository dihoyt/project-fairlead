import { IconBell } from "@tabler/icons-react";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { NotificationsPage } from "./NotificationsPage";

export const navItems: NavItem[] = [
  { label: "Notifications", to: "/notifications", icon: IconBell, order: 10, section: "admin" },
];

export const routes: ModuleRoute[] = [{ path: "/notifications", element: <NotificationsPage /> }];
