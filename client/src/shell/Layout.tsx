import { useEffect } from "react";
import {
  ActionIcon,
  AppShell,
  Avatar,
  Burger,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Text,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconLogout, IconMoon, IconSun } from "@tabler/icons-react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router";
import { product } from "../product";
import type { NavItem } from "../ui/contracts";
import { useSession } from "../ui/session";
import { signOut } from "./auth/signOut";
import { ErrorBoundary } from "./ErrorBoundary";
import { firstRunSteps, navItems as moduleNavItems, routes as moduleRoutes } from "./modules";
import { Placeholder } from "./Placeholder";
import { accountNavItem, shellNavItems, shellRoutes } from "./routes";
import { useFirstRun } from "./useFirstRun";

const byOrder = (a: NavItem, b: NavItem) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label);

function isActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme("dark");
  const next = computed === "dark" ? "light" : "dark";
  return (
    <Tooltip label={`Switch to ${next} mode`}>
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label={`Switch to ${next} mode`}
        onClick={() => setColorScheme(next)}
      >
        {computed === "dark" ? <IconSun size={18} stroke={1.5} /> : <IconMoon size={18} stroke={1.5} />}
      </ActionIcon>
    </Tooltip>
  );
}

function UserMenu() {
  const { me, refresh } = useSession();
  const detail = me.email || (me.source === "dev-bypass" ? "Development bypass" : me.id);
  return (
    <Menu position="bottom-end" width={220} withinPortal>
      <Menu.Target>
        <UnstyledButton aria-label="Account menu">
          <Group gap="xs" wrap="nowrap">
            <Avatar radius="xl" size={28} name={me.name} color="cyan" />
            <Text size="sm" visibleFrom="sm" truncate maw={160}>
              {me.name}
            </Text>
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          <Text size="xs" truncate>
            {detail}
          </Text>
        </Menu.Label>
        {me.source !== "dev-bypass" && accountNavItem.icon ? (
          <Menu.Item component={Link} to={accountNavItem.to} leftSection={<accountNavItem.icon size={14} />}>
            {accountNavItem.label}
          </Menu.Item>
        ) : null}
        {me.source !== "dev-bypass" ? (
          <Menu.Item color="red" leftSection={<IconLogout size={14} />} onClick={() => signOut(refresh)}>
            Sign out
          </Menu.Item>
        ) : null}
      </Menu.Dropdown>
    </Menu>
  );
}

function NavSection({ items, pathname, onNavigate }: { items: NavItem[]; pathname: string; onNavigate: () => void }) {
  return items.map((item) => (
    <NavLink
      key={item.to}
      component={Link}
      to={item.to}
      label={item.label}
      active={isActive(pathname, item.to)}
      onClick={onNavigate}
      leftSection={item.icon ? <item.icon size={18} stroke={1.5} /> : null}
    />
  ));
}

export function Layout() {
  const { me, methods } = useSession();
  const { pathname } = useLocation();
  useFirstRun(firstRunSteps);
  const [mobileOpened, { toggle: toggleMobile, close: closeMobile }] = useDisclosure(false);
  const [desktopOpened, { toggle: toggleDesktop }] = useDisclosure(true);

  const visible = [...moduleNavItems, ...shellNavItems.filter((item) => !item.adminOnly || me.admin)];
  const main = visible.filter((item) => (item.section ?? "main") === "main").toSorted(byOrder);
  const admin = visible.filter((item) => item.section === "admin").toSorted(byOrder);
  const siteName = methods?.siteName;

  useEffect(() => {
    document.title =
      siteName && siteName !== product.displayName ? `${siteName} · ${product.displayName}` : product.displayName;
  }, [siteName]);

  return (
    <AppShell
      header={{ height: 52 }}
      navbar={{ width: 232, breakpoint: "sm", collapsed: { mobile: !mobileOpened, desktop: !desktopOpened } }}
      padding="lg"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger
              opened={mobileOpened}
              onClick={toggleMobile}
              hiddenFrom="sm"
              size="sm"
              aria-label="Toggle navigation"
            />
            <Burger
              opened={desktopOpened}
              onClick={toggleDesktop}
              visibleFrom="sm"
              size="sm"
              aria-label="Toggle navigation"
            />
            <Text fw={700} component={Link} to="/" style={{ color: "inherit", textDecoration: "none" }}>
              {product.displayName}
            </Text>
            {siteName && siteName !== product.displayName ? (
              <Text size="sm" c="dimmed" visibleFrom="xs" truncate>
                {siteName}
              </Text>
            ) : null}
          </Group>
          <Group gap="sm" wrap="nowrap">
            <ColorSchemeToggle />
            <UserMenu />
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <AppShell.Section grow component={ScrollArea}>
          <NavSection items={main} pathname={pathname} onNavigate={closeMobile} />
          {admin.length > 0 ? (
            <>
              <Text size="xs" fw={600} c="dimmed" tt="uppercase" px="sm" pt="md" pb={4}>
                Admin
              </Text>
              <NavSection items={admin} pathname={pathname} onNavigate={closeMobile} />
            </>
          ) : null}
        </AppShell.Section>
        <AppShell.Section>
          <Text size="xs" c="dimmed" px="sm" py={4}>
            {product.tagline}
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main>
        <ErrorBoundary key={pathname}>
          <Routes>
            <Route path="/" element={<Navigate to={main[0]?.to ?? "/account"} replace />} />
            {[...moduleRoutes, ...shellRoutes].map((route) => (
              <Route key={route.path} path={route.path} element={route.element} />
            ))}
            <Route path="*" element={<Placeholder title="Not found" note={`Nothing lives at ${pathname}.`} />} />
          </Routes>
        </ErrorBoundary>
      </AppShell.Main>
    </AppShell>
  );
}
