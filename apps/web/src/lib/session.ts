/**
 * web-auth: the admin session inside Next (cookies, env, redirects) over services/auth. Server-only.
 * Workspace choice: `?w=<slug>` (links from Telegram alerts carry it) → the `shuttle_ws` cookie (set by the
 * switcher's server action) → the live workspace → the first membership.
 */
import { notImplemented, type Role } from "@eci-shuttle/shared";
import type { Person, Workspace } from "@/db/types";
import type { Actor } from "@/services/kernel";

export const WORKSPACE_COOKIE = "shuttle_ws";

/** The logged-in person from the signed session cookie (auth/session.verifySession), or null. */
export async function currentPerson(): Promise<Person | null> {
  return notImplemented();
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
  return notImplemented(opts);
}

/** Set the signed session cookie (httpOnly, secure, sameSite lax, 60 days) for a person who just logged in. */
export async function startSession(personId: string): Promise<void> {
  return notImplemented(personId);
}

export async function endSession(): Promise<void> {
  return notImplemented();
}
