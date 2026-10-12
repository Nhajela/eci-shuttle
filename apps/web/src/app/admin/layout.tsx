/**
 * admin-shell (SPEC §7): the phone-first frame around every admin page: workspace switcher, TEST banner, bottom
 * tab bar on phones (Live · Schedule · Notices · Phones · More), sidebar on desktop. Components in
 * components/admin/shell/. Auth is checked by each page via lib/session.requireAdmin (layouts don't see ?w=).
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full flex-col">{children}</div>;
}
