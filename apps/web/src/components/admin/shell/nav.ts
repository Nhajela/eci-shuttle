/** admin-shell: the admin navigation and workspace choice, as plain data (shared by the client shell and the server action). */
import type { Role } from "@eci-shuttle/shared";

export type NavItem = { href: string; label: string };
/** What the shell needs per workspace; built on the server from listMyWorkspaces. */
export type ShellWorkspace = { slug: string; name: string; isLive: boolean; role: Role };

/** Bottom tab bar on phones (SPEC §7); the fifth tab, More, opens MORE. */
export const TABS: NavItem[] = [
  { href: "/admin/live", label: "Live" },
  { href: "/admin/schedule", label: "Schedule" },
  { href: "/admin/notices", label: "Notices" },
  { href: "/admin/phones", label: "Phones" },
];

export const MORE: NavItem[] = [
  { href: "/admin/vehicles", label: "Vehicles" },
  { href: "/admin/spots", label: "Spots" },
  { href: "/admin/routes", label: "Routes" },
  { href: "/admin/people", label: "People" },
  { href: "/admin/insights", label: "Insights" },
  { href: "/admin/activity", label: "Activity" },
  { href: "/admin/workspaces", label: "Workspaces" },
];

/**
 * Mirrors lib/session.requireAdmin (`w ?? cookie` → resolveWorkspace): `?w=` when it's one of mine; an unknown `?w=`
 * → live → first (never the cookie, or the header could say TEST while the page writes live); no `?w=` → the
 * server-resolved cookie workspace (`fallbackSlug`).
 */
export function pickWorkspace(list: ShellWorkspace[], w: string | null, fallbackSlug: string): ShellWorkspace | null {
  const slug = w ?? fallbackSlug;
  return list.find((x) => x.slug === slug) ?? list.find((x) => x.isLive) ?? list[0] ?? null;
}

/** For a page form's Save bar (SPEC §7 sticky Save): sticks above the phone tab bar, at the bottom on desktop. */
export const STICKY_SAVE = "sticky bottom-[var(--admin-tabbar)] z-30";

export function withWorkspace(href: string, slug: string): string {
  return `${href}?w=${encodeURIComponent(slug)}`;
}

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The switcher posts the current path back; only plain /admin paths are redirected to. */
export function safeAdminPath(path: string | null | undefined): string {
  return path && /^\/admin(\/[\w-]+)*$/.test(path) ? path : "/admin/live";
}
