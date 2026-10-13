"use server";
/** admin-live: the Live board's quick actions (SPEC §7: at most 2 taps). Thin: session → service → plain result. */
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { endBreak, startBreak } from "@/services/catalog/breaks";
import { addException } from "@/services/catalog/schedule";
import { nudgePhone, silencePhone } from "@/services/devices/phones";
import { type Actor, userMessage } from "@/services/kernel";
import { createNotice } from "@/services/notices/notices";

export type ActionResult = { ok: true } | { ok: false; error: string };

async function run(
  w: string | null,
  fn: (actor: Actor, workspaceId: string) => Promise<unknown>,
): Promise<ActionResult> {
  try {
    const { actor, workspace } = await requireAdmin({ w, minRole: "ops" });
    await fn(actor, workspace.id);
    revalidatePath("/admin/live");
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e); // login redirects
    return { ok: false, error: userMessage(e) };
  }
}

export async function silenceAction(w: string | null, deviceId: string, hours: number): Promise<ActionResult> {
  return run(w, (actor, workspaceId) =>
    silencePhone(db(), actor, {
      workspaceId,
      deviceId,
      until: new Date(Date.now() + hours * 3_600_000).toISOString(),
    }),
  );
}

export async function nudgeAction(w: string | null, deviceId: string): Promise<ActionResult> {
  return run(w, (actor, workspaceId) => nudgePhone(db(), actor, { workspaceId, deviceId }));
}

export async function postNoticeAction(w: string | null, text: string, urgent: boolean): Promise<ActionResult> {
  return run(w, (actor, workspaceId) =>
    createNotice(db(), actor, { workspaceId, text, severity: urgent ? "urgent" : "info", placements: ["everywhere"] }),
  );
}

export async function cancelDepartureAction(
  w: string | null,
  serviceId: string,
  date: string,
  departure: string,
): Promise<ActionResult> {
  return run(w, (actor, workspaceId) =>
    addException(db(), actor, { workspaceId, serviceId, date, type: "cancel_departure", departure }),
  );
}

/** A driver's break from now: `minutes` long, or until ended by hand (null). */
export async function startBreakAction(
  w: string | null,
  vehicleId: string,
  minutes: number | null,
): Promise<ActionResult> {
  return run(w, (actor, workspaceId) => startBreak(db(), actor, { workspaceId, vehicleId, minutes }, new Date()));
}

export async function endBreakAction(w: string | null, vehicleId: string): Promise<ActionResult> {
  return run(w, (actor, workspaceId) => endBreak(db(), actor, { workspaceId, vehicleId }, new Date()));
}
