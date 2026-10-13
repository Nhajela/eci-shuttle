/** admin-people: pure helpers shared by the People page, its server actions and its client components. */
import { type AlertKind, formatIst, type Role } from "@eci-shuttle/shared";
import type { McpToken, Person } from "@/db/types";
import { isServiceError, userMessage } from "@/services/kernel/errors";

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  ops: "Ops",
  viewer: "Viewer",
};

export const ROLE_HINT: Record<Role, string> = {
  admin: "Everything, including roles, kill and revoke",
  ops: "Schedule, notices, silence, nudge, spots",
  viewer: "Read only",
};

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  silent: "Vehicle silent",
  off_route: "Vehicle off route",
  low_battery: "Low battery",
  permission_lost: "Location permission lost",
  mode_mismatch: "Phone not doing what it was told",
  kill_resume: "Phone killed or resumed",
  update_failed: "App update failed",
  admin_changes: "Changes by other admins",
  digest: "Nightly digest",
  pickup_request: "Someone needs a shuttle (/need)",
};

export type ActionResult = { ok: true; message?: string; token?: string } | { ok: false; error: string };

export function personName(p: Pick<Person, "firstName" | "lastName" | "username">): string {
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ");
  const at = p.username ? `@${p.username}` : "";
  if (name && at) return `${name} (${at})`;
  return name || at || "Unnamed";
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

/** Form → catalog/people.setRole input. An empty role removes the membership. */
export function parseRoleForm(fd: FormData, workspaceId: string) {
  const personId = str(fd, "personId");
  const role = str(fd, "role");
  return {
    workspaceId,
    person: personId ? { personId } : { username: str(fd, "username").replace(/^@/, "") },
    role: (role || null) as Role | null,
  };
}

/** Form → alerts/prefs.setAlertPrefs input. Empty times = no quiet hours (the service checks both-or-neither). */
export function parseAlertPrefsForm(fd: FormData, workspaceId: string) {
  const version = str(fd, "version");
  return {
    workspaceId,
    kinds: fd.getAll("kinds").map(String) as AlertKind[],
    quietFrom: str(fd, "quietFrom") || null,
    quietTo: str(fd, "quietTo") || null,
    version: version ? Number(version) : undefined,
  };
}

type TokenTimes = Pick<McpToken, "revokedAt" | "expiresAt" | "lastUsedAt">;

export function tokenStatus(t: TokenTimes, now: number): "active" | "revoked" | "expired" {
  if (t.revokedAt) return "revoked";
  if (t.expiresAt && t.expiresAt.getTime() <= now) return "expired";
  return "active";
}

export const tokenUsed = (t: TokenTimes) => (t.lastUsedAt ? `Last used ${formatIst(t.lastUsedAt)}` : "Never used");

/** Subscriber counts with spot names: "All spots" first, then by name; spots no longer listed last. */
export function subscriberRows(
  counts: { spotId: string | null; notices: number; arrivalAlerts: number }[],
  spots: { id: string; name: string }[],
) {
  const names = new Map(spots.map((s) => [s.id, s.name]));
  const rank = (c: (typeof counts)[number]) => (c.spotId === null ? 0 : names.has(c.spotId) ? 1 : 2);
  return counts
    .map((c) => ({
      ...c,
      key: c.spotId ?? "all",
      name: c.spotId === null ? "All spots" : (names.get(c.spotId) ?? "Archived spot"),
    }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** A failed server action: service errors keep their plain-English message, anything else is logged and hidden. */
export function actionError(e: unknown, log: (e: unknown) => void = console.error): ActionResult {
  if (!isServiceError(e)) log(e);
  return { ok: false, error: userMessage(e) };
}
