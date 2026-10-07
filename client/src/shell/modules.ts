import type { ClientModule, FirstRunStep, ModuleRoute, NavItem } from "../ui/contracts";

// Every client module is picked up from its folder, so adding one edits no
// shared file.
const found = import.meta.glob<ClientModule>("../modules/*/index.tsx", { eager: true });

export const clientModules: ClientModule[] = Object.values(found);

export const navItems: NavItem[] = clientModules.flatMap((mod) => mod.navItems);

export const routes: ModuleRoute[] = clientModules.flatMap((mod) => mod.routes);

export const firstRunSteps: FirstRunStep[] = clientModules.flatMap((mod) => (mod.firstRun ? [mod.firstRun] : []));
