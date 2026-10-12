"use server";
/** admin-spots server actions: thin adapters over services/catalog/spots (role, scope and audit live there). */
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { archiveSpot, createSpot, updateSpot } from "@/services/catalog/spots";
import { type Actor, userMessage } from "@/services/kernel";

export type ActionResult = { ok: true } | { ok: false; error: string };

export type SpotFormFields = {
  /** absent = create */
  spotId?: string;
  version?: number;
  name: string;
  shortName: string;
  lat: number;
  lng: number;
  radiusM: number;
  notes: string | null;
};

async function run(
  w: string | null,
  fn: (workspaceId: string, actor: Actor) => Promise<unknown>,
): Promise<ActionResult> {
  const { actor, workspace } = await requireAdmin({ w, minRole: "ops" });
  try {
    await fn(workspace.id, actor);
  } catch (e) {
    return { ok: false, error: userMessage(e) };
  }
  revalidatePath("/admin/spots");
  return { ok: true };
}

export async function saveSpotAction(w: string | null, fields: SpotFormFields): Promise<ActionResult> {
  return run(w, (workspaceId, actor) =>
    fields.spotId
      ? updateSpot(db(), actor, { ...fields, spotId: fields.spotId, workspaceId })
      : createSpot(db(), actor, { ...fields, workspaceId }),
  );
}

export async function archiveSpotAction(
  w: string | null,
  input: { spotId: string; version?: number },
): Promise<ActionResult> {
  return run(w, (workspaceId, actor) => archiveSpot(db(), actor, { ...input, workspaceId }));
}
