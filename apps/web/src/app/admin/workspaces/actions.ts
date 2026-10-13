"use server";
/** admin-workspaces server actions: parse the form, build the Actor, call one service, map errors. */
import { istHHMM } from "@eci-shuttle/shared";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { createWorkspace, updateWorkspace } from "@/services/catalog/workspaces";
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

/** Ops tracking hours: two native time inputs; the Turn off button (or both empty) clears them. Admin only. */
export async function opsHoursAction(_prev: ActionState, fd: FormData): Promise<NonNullable<ActionState>> {
  const { actor, workspace } = await requireAdmin({ w: fd.get("w") as string | null, minRole: "admin" });
  const off = fd.has("off");
  const start = off ? null : str(fd, "start") || null;
  const end = off ? null : str(fd, "end") || null;
  try {
    await updateWorkspace(db(), actor, { workspaceId: workspace.id, opsHoursStart: start, opsHoursEnd: end });
    revalidatePath(PATH);
    return {
      ok: true,
      message: start
        ? `Phones in vehicles track ${start}–${end} every day.`
        : "Ops hours off: phones track only during services.",
    };
  } catch (e) {
    return fail(e);
  }
}

export async function startSimAction(_prev: ActionState, fd: FormData): Promise<NonNullable<ActionState>> {
  const { actor, workspace } = await requireAdmin({ w: fd.get("w") as string | null, minRole: "admin" });
  // pairDevice also refuses a simulated pair into the live workspace; this just avoids minting a useless code.
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
