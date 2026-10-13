"use server";
/** admin-notices server actions: build the actor (ops+), call svc-notices, map errors to plain text. */
import type { NoticeCreateFields } from "@eci-shuttle/shared";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { setWorkspaceInfo } from "@/services/catalog/workspaces";
import { type Actor, isServiceError, userMessage } from "@/services/kernel";
import { createNotice, endNotice, updateNotice } from "@/services/notices/notices";

export type ActionResult = { ok: true } | { ok: false; error: string };

async function run(w: string | null, fn: (workspaceId: string, actor: Actor) => Promise<unknown>) {
  try {
    const { workspace, actor } = await requireAdmin({ w, minRole: "ops" });
    await fn(workspace.id, actor);
  } catch (e) {
    if (!isServiceError(e)) throw e; // redirects and real failures
    return { ok: false, error: userMessage(e) } satisfies ActionResult;
  }
  revalidatePath("/admin/notices");
  return { ok: true } satisfies ActionResult;
}

export async function createNoticeAction(
  w: string | null,
  form: z.input<typeof NoticeCreateFields>,
): Promise<ActionResult> {
  return run(w, (workspaceId, actor) => createNotice(db(), actor, { ...form, workspaceId }));
}

export async function endNoticeAction(w: string | null, noticeId: string): Promise<ActionResult> {
  return run(w, (workspaceId, actor) => endNotice(db(), actor, { workspaceId, noticeId }));
}

export async function pinNoticeAction(
  w: string | null,
  noticeId: string,
  pinned: boolean,
  version: number,
): Promise<ActionResult> {
  return run(w, (workspaceId, actor) => updateNotice(db(), actor, { workspaceId, noticeId, pinned, version }));
}

/** The public page's info board (markdown; blank clears it). The public page is dynamic, so it shows at once. */
export async function setInfoAction(w: string | null, infoMd: string, version: number): Promise<ActionResult> {
  return run(w, (workspaceId, actor) => setWorkspaceInfo(db(), actor, { workspaceId, infoMd, version }));
}
