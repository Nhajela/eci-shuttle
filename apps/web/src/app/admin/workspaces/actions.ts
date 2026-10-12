"use server";
/** admin-workspaces server actions: parse the form, build the Actor, call one service, map errors. */
import { istHHMM } from "@eci-shuttle/shared";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { createWorkspace } from "@/services/catalog/workspaces";
import { createPairingCode } from "@/services/devices/pairing";
import { revokePhone } from "@/services/devices/phones";
import { userMessage } from "@/services/kernel";
import { simCommand, simLabel } from "./sim";

export type ActionState = { ok: boolean; message: string; slug?: string; command?: string } | null;

const PATH = "/admin/workspaces";
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const fail = (e: unknown) => ({ ok: false, message: userMessage(e) });

export async function createWorkspaceAction(_prev: ActionState, fd: FormData): Promise<NonNullable<ActionState>> {
  const { actor } = await requireAdmin({ w: fd.get("w") as string | null });
  try {
    const ws = await createWorkspace(db(), actor, { slug: str(fd, "slug"), name: str(fd, "name") });
    revalidatePath(PATH);
    return { ok: true, message: `Created ${ws.name}.`, slug: ws.slug };
  } catch (e) {
    return fail(e);
  }
}

export async function startSimAction(_prev: ActionState, fd: FormData): Promise<NonNullable<ActionState>> {
  const { actor, workspace } = await requireAdmin({ w: fd.get("w") as string | null, minRole: "admin" });
  // ponytail: the live-workspace refusal belongs in the pairing service (contract request); checked here until then.
  if (workspace.isLive) return { ok: false, message: "Simulated phones only run in test workspaces." };
  const vehicle = str(fd, "vehicle").trim();
  if (!vehicle) return { ok: false, message: "Pick a vehicle." };
  try {
    const p = await createPairingCode(db(), actor, { workspaceId: workspace.id, label: simLabel(vehicle) });
    return {
      ok: true,
      message: `Code ${p.code} works until ${istHHMM(p.expiresAt)}.`,
      command: simCommand(workspace.slug, vehicle, p.code),
    };
  } catch (e) {
    return fail(e);
  }
}

export async function stopSimAction(_prev: ActionState, fd: FormData): Promise<NonNullable<ActionState>> {
  const { actor, workspace } = await requireAdmin({ w: fd.get("w") as string | null, minRole: "admin" });
  try {
    await revokePhone(db(), actor, { workspaceId: workspace.id, deviceId: str(fd, "deviceId") });
    revalidatePath(PATH);
    return { ok: true, message: "Stopped. The sim stops on its next sync." };
  } catch (e) {
    return fail(e);
  }
}
