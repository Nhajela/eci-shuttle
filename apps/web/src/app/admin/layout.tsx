/**
 * admin-shell (SPEC §7): the phone-first frame around every admin page: workspace switcher, TEST banner, bottom
 * tab bar on phones (Live · Schedule · Notices · Phones · More), sidebar on desktop. Components in
 * components/admin/shell/. Layouts don't see ?w=, so each page still checks its own role via
 * lib/session.requireAdmin; this guard only keeps logged-out people and non-members out of the whole tree.
 */
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/shell/admin-shell";
import { LoginRedirect } from "@/components/admin/shell/login-redirect";
import { db } from "@/db";
import { currentPerson, WORKSPACE_COOKIE } from "@/lib/session";
import { adminActor, resolveWorkspace } from "@/services/auth/actor";
import { listMyWorkspaces } from "@/services/catalog/workspaces";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const person = await currentPerson();
  if (!person) return <LoginRedirect />;

  const resolved = await resolveWorkspace(db(), person.id, (await cookies()).get(WORKSPACE_COOKIE)?.value);
  if (!resolved) {
    return (
      <main className="p-4">
        <h1 className="text-lg font-semibold">No access yet</h1>
        <p className="mt-2 text-muted-foreground">
          You're logged in, but not a member of any workspace. Ask an admin to add you.
        </p>
      </main>
    );
  }

  const actor = await adminActor(db(), { personId: person.id, workspaceId: resolved.workspace.id, channel: "web" });
  const workspaces = (await listMyWorkspaces(db(), actor)).map((w) => ({
    slug: w.slug,
    name: w.name,
    isLive: w.isLive,
    role: w.role,
  }));

  return (
    <AdminShell workspaces={workspaces} fallbackSlug={resolved.workspace.slug}>
      {children}
    </AdminShell>
  );
}
