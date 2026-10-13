"use client";
/** admin-shell (SPEC §7): workspace switcher + TEST banner on top, bottom tabs on phones, sidebar on desktop. */
import { cn } from "cn";
import {
  ActivityIcon,
  BarChart3Icon,
  BusIcon,
  CalendarClockIcon,
  LogOutIcon,
  type LucideIcon,
  MapPinIcon,
  MegaphoneIcon,
  MenuIcon,
  RadarIcon,
  RouteIcon,
  SmartphoneIcon,
  UsersIcon,
  WaypointsIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { switchWorkspace } from "./actions";
import { isActive, MORE, type NavItem, pickWorkspace, type ShellWorkspace, TABS, withWorkspace } from "./nav";

const ICONS: Record<string, LucideIcon> = {
  "/admin/live": RadarIcon,
  "/admin/schedule": CalendarClockIcon,
  "/admin/notices": MegaphoneIcon,
  "/admin/phones": SmartphoneIcon,
  "/admin/vehicles": BusIcon,
  "/admin/spots": MapPinIcon,
  "/admin/routes": RouteIcon,
  "/admin/people": UsersIcon,
  "/admin/insights": BarChart3Icon,
  "/admin/activity": ActivityIcon,
  "/admin/workspaces": WaypointsIcon,
};

export function AdminShell({
  workspaces,
  fallbackSlug,
  children,
}: {
  workspaces: ShellWorkspace[];
  fallbackSlug: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const current = pickWorkspace(workspaces, useSearchParams().get("w"), fallbackSlug);
  const [moreOpen, setMoreOpen] = useState(false);
  if (!current) return children;
  const link = (item: NavItem) => withWorkspace(item.href, current.slug);
  const moreActive = MORE.some((i) => isActive(pathname, i.href));

  return (
    // --admin-tabbar: the phone tab bar's height, so pages' sticky Save (nav.STICKY_SAVE) sits above it
    <div className="flex min-h-full flex-1 [--admin-tabbar:calc(3.5rem+1px+env(safe-area-inset-bottom))] md:flex-row md:[--admin-tabbar:0px]">
      <aside className="hidden w-56 shrink-0 flex-col gap-1 border-r p-3 md:flex">
        <p className="px-3 pb-2 font-semibold">ECI Shuttle</p>
        {[...TABS, ...MORE].map((item) => (
          <NavLink key={item.href} item={item} href={link(item)} active={isActive(pathname, item.href)} row />
        ))}
        <LogOut className="mt-auto" />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col pb-[var(--admin-tabbar)]">
        <header className="sticky top-0 z-30 border-b bg-background">
          <div className="flex min-h-14 items-center gap-2 px-4">
            <WorkspaceSwitcher workspaces={workspaces} current={current} pathname={pathname} />
            <span className="ml-auto shrink-0 text-sm text-muted-foreground">{current.role}</span>
          </div>
          {!current.isLive && (
            <p role="status" className="bg-amber-400 px-4 py-1.5 text-sm font-semibold text-black">
              TEST · {current.name}: nothing here reaches the real shuttle or attendees.
            </p>
          )}
        </header>
        <div className="min-w-0 flex-1">{children}</div>
      </div>

      <nav
        aria-label="Admin"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {TABS.map((item) => (
          <NavLink key={item.href} item={item} href={link(item)} active={isActive(pathname, item.href)} />
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-current={moreActive ? "page" : undefined}
          className={tabClass(moreActive)}
        >
          <MenuIcon className="size-5" aria-hidden />
          More
        </button>
      </nav>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent className="top-auto bottom-4 translate-y-0">
          <DialogTitle>More</DialogTitle>
          <div className="grid grid-cols-2 gap-2">
            {MORE.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                href={link(item)}
                active={isActive(pathname, item.href)}
                row
                onClick={() => setMoreOpen(false)}
              />
            ))}
          </div>
          <LogOut />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LogOut({ className }: { className?: string }) {
  return (
    <form method="post" action="/api/auth/logout" className={className}>
      <button
        type="submit"
        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted/60"
      >
        <LogOutIcon className="size-5 shrink-0" aria-hidden />
        Log out
      </button>
    </form>
  );
}

const tabClass = (active: boolean) =>
  cn(
    "flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs",
    active ? "font-semibold text-foreground" : "text-muted-foreground",
  );

function NavLink({
  item,
  href,
  active,
  row,
  onClick,
}: {
  item: NavItem;
  href: string;
  active: boolean;
  row?: boolean;
  onClick?: () => void;
}) {
  const Icon = ICONS[item.href];
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={
        row
          ? cn(
              "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm",
              active ? "bg-muted font-semibold" : "hover:bg-muted/60",
            )
          : tabClass(active)
      }
    >
      {Icon && <Icon className="size-5 shrink-0" aria-hidden />}
      {item.label}
    </Link>
  );
}

function WorkspaceSwitcher({
  workspaces,
  current,
  pathname,
}: {
  workspaces: ShellWorkspace[];
  current: ShellWorkspace;
  pathname: string;
}) {
  if (workspaces.length < 2) return <span className="truncate font-semibold">{current.name}</span>;
  return (
    <form action={switchWorkspace} className="min-w-0">
      <input type="hidden" name="path" value={pathname} />
      <label className="sr-only" htmlFor="admin-workspace">
        Workspace
      </label>
      <select
        id="admin-workspace"
        name="w"
        // keyed so a back/forward navigation resets the uncontrolled value
        key={current.slug}
        defaultValue={current.slug}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-11 max-w-full truncate rounded-lg border bg-background px-2 font-semibold"
      >
        {workspaces.map((w) => (
          <option key={w.slug} value={w.slug}>
            {w.isLive ? w.name : `${w.name} (test)`}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="ml-2 h-11 underline">
          Switch
        </button>
      </noscript>
    </form>
  );
}
