import { IconBox } from "@tabler/icons-react";
import type { ModuleRoute, NavItem } from "../../ui/contracts";
import { PodPage } from "./PodPage";
import { SpacePage } from "./SpacePage";
import { SpacesPage } from "./SpacesPage";
import { WorkloadPage } from "./WorkloadPage";

export const navItems: NavItem[] = [{ label: "Workloads", to: "/workloads", icon: IconBox, order: 50 }];

// Health checks link into these by object: a Pod to its page, a workload
// kind to /workloads/<namespace>/<Kind>/<name>, a Namespace to its space.
export const routes: ModuleRoute[] = [
  { path: "/workloads", element: <SpacesPage /> },
  { path: "/workloads/:namespace", element: <SpacePage /> },
  { path: "/workloads/:namespace/pods/:pod", element: <PodPage /> },
  { path: "/workloads/:namespace/:kind/:name", element: <WorkloadPage /> },
];
