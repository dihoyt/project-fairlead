import { IconServer } from "@tabler/icons-react";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { NodePage } from "./NodePage";
import { NodesPage } from "./NodesPage";
import { PodPage } from "./PodPage";

export const navItems: NavItem[] = [{ label: "Nodes", to: "/nodes", icon: IconServer, order: 30 }];

export const routes: ModuleRoute[] = [
  { path: "/nodes", element: <NodesPage /> },
  { path: "/nodes/:name", element: <NodePage /> },
  { path: "/nodes/:name/pods/:namespace/:pod", element: <PodPage /> },
];
