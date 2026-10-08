import { IconPlugConnected } from "@tabler/icons-react";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { ConnectorsPage } from "./ConnectorsPage";

export const navItems: NavItem[] = [
  { label: "Connectors", to: "/admin/connectors", icon: IconPlugConnected, order: 222, section: "admin" },
];

export const routes: ModuleRoute[] = [{ path: "/admin/connectors", element: <ConnectorsPage /> }];
