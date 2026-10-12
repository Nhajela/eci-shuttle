"use server";
/** admin-people server actions: parse the form, build the Actor, call the service, map errors. No rules here. */
import { revalidatePath } from "next/cache";
import { type ActionResult, actionError, parseAlertPrefsForm, parseRoleForm } from "@/components/admin/people/people";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { setAlertPrefs } from "@/services/alerts/prefs";
import { setRole } from "@/services/catalog/people";
import { createPersonalToken, revokeToken } from "@/services/mcp/tokens";

const w = (fd: FormData) => (fd.get("w") as string | null) || null;

// requireAdmin stays outside try: its redirect must not be swallowed as an error.
export async function setRoleAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { actor, workspace } = await requireAdmin({ w: w(fd), minRole: "admin" });
  try {
    const m = await setRole(db(), actor, parseRoleForm(fd, workspace.id));
    revalidatePath("/admin/people");
    return { ok: true, message: m ? "Role saved." : "Removed from this workspace." };
  } catch (e) {
    return actionError(e);
  }
}

export async function setAlertPrefsAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { actor, workspace } = await requireAdmin({ w: w(fd) });
  try {
    await setAlertPrefs(db(), actor, parseAlertPrefsForm(fd, workspace.id));
    revalidatePath("/admin/people");
    return { ok: true, message: "Alert settings saved." };
  } catch (e) {
    return actionError(e);
  }
}

export async function createTokenAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { actor } = await requireAdmin({ w: w(fd) });
  try {
    const { token } = await createPersonalToken(db(), actor, { name: String(fd.get("name") ?? "") });
    revalidatePath("/admin/people");
    return { ok: true, token };
  } catch (e) {
    return actionError(e);
  }
}

export async function revokeTokenAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { actor } = await requireAdmin({ w: w(fd) });
  try {
    await revokeToken(db(), actor, { tokenId: String(fd.get("tokenId") ?? "") }, new Date());
    revalidatePath("/admin/people");
    return { ok: true, message: "Token revoked." };
  } catch (e) {
    return actionError(e);
  }
}
