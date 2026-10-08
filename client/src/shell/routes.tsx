import { lazy, Suspense, type ReactNode } from "react";
import {
  IconComponents,
  IconApi,
  IconHistory,
  IconKey,
  IconServerCog,
  IconSettings,
  IconUserCircle,
  IconUsers,
} from "@tabler/icons-react";
import { Alert, Loader } from "@mantine/core";
import type { ModuleRoute, NavItem } from "../ui/contracts";
import { useSession } from "../ui/session";
import { AccountPage } from "./account/AccountPage";
import { AuditPage } from "./admin/AuditPage";
import { SettingsPage } from "./admin/SettingsPage";
import { SignInSettingsPage } from "./admin/SignInSettingsPage";
import { SystemPage } from "./admin/SystemPage";
import { TokensPage } from "./admin/TokensPage";
import { UsersPage } from "./admin/UsersPage";

export interface ShellNavItem extends NavItem {
  adminOnly?: boolean;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { me } = useSession();
  return me.admin ? children : <Alert color="yellow">This page is for admins.</Alert>;
}

// The shell's own pages, beside the ones client modules contribute. Admin
// pages sort after module admin items (order 100+).
export const shellNavItems: ShellNavItem[] = [
  { label: "Users", to: "/admin/users", icon: IconUsers, order: 200, section: "admin", adminOnly: true },
  { label: "Sign-in", to: "/admin/sign-in", icon: IconKey, order: 210, section: "admin", adminOnly: true },
  { label: "Settings", to: "/admin/settings", icon: IconSettings, order: 220, section: "admin", adminOnly: true },
  { label: "API tokens", to: "/admin/tokens", icon: IconApi, order: 225, section: "admin", adminOnly: true },
  { label: "Audit log", to: "/admin/audit", icon: IconHistory, order: 230, section: "admin", adminOnly: true },
  { label: "System", to: "/admin/system", icon: IconServerCog, order: 240, section: "admin", adminOnly: true },
  ...(import.meta.env.DEV
    ? [{ label: "Components", to: "/components", icon: IconComponents, order: 900, section: "admin" as const }]
    : []),
];

// Reached from the user menu rather than the sidebar.
export const accountNavItem: NavItem = { label: "Account", to: "/account", icon: IconUserCircle };

// Split out: it carries the mock data, which no other page needs.
const ComponentsPage = lazy(() => import("./demo/ComponentsPage").then((m) => ({ default: m.ComponentsPage })));

const admin = (element: ReactNode) => <AdminOnly>{element}</AdminOnly>;

export const shellRoutes: ModuleRoute[] = [
  { path: "/account", element: <AccountPage /> },
  { path: "/admin/users", element: admin(<UsersPage />) },
  { path: "/admin/sign-in", element: admin(<SignInSettingsPage />) },
  { path: "/admin/settings", element: admin(<SettingsPage />) },
  { path: "/admin/tokens", element: admin(<TokensPage />) },
  { path: "/admin/audit", element: admin(<AuditPage />) },
  { path: "/admin/system", element: admin(<SystemPage />) },
  // Always routable so a module author can open it in any build; only
  // listed in the sidebar in development.
  {
    path: "/components",
    element: (
      <Suspense fallback={<Loader size="sm" />}>
        <ComponentsPage />
      </Suspense>
    ),
  },
];
