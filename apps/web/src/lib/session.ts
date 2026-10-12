/**
 * web-auth: the admin session inside Next (cookies, env, redirects) over services/auth. Server-only.
 * Workspace choice: `?w=<slug>` (links from Telegram alerts carry it) → the `shuttle_ws` cookie (set by the
 * switcher's server action) → the live workspace → the first membership.
 */
import { ROLE_RANK, type Role } from "@eci-shuttle/shared";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { people } from "@/db/schema";
import type { Person, Workspace } from "@/db/types";
import { adminActor, resolveWorkspace } from "@/services/auth/actor";
import { LOGIN_CODE_TTL_MS } from "@/services/auth/codes";
import { SESSION_COOKIE, SESSION_TTL_MS, signSession, verifySession } from "@/services/auth/session";
import type { Actor } from "@/services/kernel";
import { env, origin } from "./env";

export const WORKSPACE_COOKIE = "shuttle_ws";
/** The code this browser is waiting on (Telegram deep-link login). httpOnly, so only this browser can poll it. */
export const LOGIN_COOKIE = "shuttle_login";

const cookieOpts = (maxAgeMs: number) => ({
  httpOnly: true,
  secure: origin().startsWith("https:"),
  sameSite: "lax" as const,
  path: "/",
  maxAge: Math.floor(maxAgeMs / 1000),
});

/**
 * Only same-site paths ("/admin/live?w=x"), never "//evil.com", "/\evil.com", absolute URLs, or control
 * characters (browsers strip tabs/newlines, so "/\t/evil.com" would become "//evil.com").
 */
export function safeNext(next: string | null | undefined, fallback = "/admin"): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (!next?.startsWith("/") || next.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(next)) return fallback;
  return next;
}

/** The logged-in person from the signed session cookie (auth/session.verifySession), or null. */
export async function currentPerson(): Promise<Person | null> {
  const s = verifySession((await cookies()).get(SESSION_COOKIE)?.value, env.sessionSecret(), Date.now());
  if (!s) return null;
  const [p] = await db().select().from(people).where(eq(people.id, s.personId));
  return p ?? null;
}

/**
 * For every admin page and server action: redirects to /login?next=<path> when logged out; resolves the workspace
 * (auth/actor.resolveWorkspace with `w` or the cookie); builds the Actor (channel "web"). Below minRole (default
 * viewer) → a "you don't have access" page. No memberships → "ask an admin to add you".
 */
export async function requireAdmin(opts: {
  w?: string | null;
  minRole?: Role;
}): Promise<{ person: Person; workspace: Workspace; role: Role; actor: Actor }> {
  const person = await currentPerson();
  // ponytail: Next gives server components no request path, so we come back to /admin (keeping ?w=), not the exact page
  if (!person) redirect(`/login?next=${encodeURIComponent(opts.w ? `/admin?w=${opts.w}` : "/admin")}`);
  const slug = opts.w ?? (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const resolved = await resolveWorkspace(db(), person.id, slug);
  if (!resolved) redirect("/login/denied?why=none");
  const { workspace, role } = resolved;
  const minRole = opts.minRole ?? "viewer";
  if (ROLE_RANK[role] < ROLE_RANK[minRole])
    redirect(`/login/denied?why=role&need=${minRole}&w=${encodeURIComponent(workspace.slug)}`);
  const actor = await adminActor(db(), { personId: person.id, workspaceId: workspace.id, channel: "web" });
  return { person, workspace, role, actor };
}

/** Set the signed session cookie (httpOnly, secure, sameSite lax, 60 days) for a person who just logged in. */
export async function startSession(personId: string): Promise<void> {
  const value = signSession({ personId, issuedAt: Date.now() }, env.sessionSecret());
  (await cookies()).set(SESSION_COOKIE, value, cookieOpts(SESSION_TTL_MS));
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function setPendingLogin(code: string): Promise<void> {
  (await cookies()).set(LOGIN_COOKIE, code, cookieOpts(LOGIN_CODE_TTL_MS));
}

export async function pendingLogin(): Promise<string | null> {
  return (await cookies()).get(LOGIN_COOKIE)?.value ?? null;
}

export async function clearPendingLogin(): Promise<void> {
  (await cookies()).delete(LOGIN_COOKIE);
}
