import { IconDevices } from "@tabler/icons-react";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { HostPage } from "./HostPage";
import { HostsPage } from "./HostsPage";

export const navItems: NavItem[] = [{ label: "Hosts", to: "/hosts", icon: IconDevices, order: 40 }];

export const routes: ModuleRoute[] = [
  { path: "/hosts", element: <HostsPage /> },
  { path: "/hosts/:id", element: <HostPage /> },
];
