"use server";
/** admin-phones server actions: resolve the admin + workspace, call one service, map errors. Roles live in the services. */
import { istHHMM } from "@eci-shuttle/shared";
import { revalidatePath } from "next/cache";
import QRCode from "qrcode";
import { istInputToIso, untilFromHours } from "@/components/admin/phones/view";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { rolloutUpdate, setPhoneUpdate } from "@/services/devices/ota";
import { createPairingCode } from "@/services/devices/pairing";
import {
  assignPhone,
  cancelDirective,
  forceActive,
  killPhone,
  labelPhone,
  movePhoneToWorkspace,
  nudgePhone,
  resumePhone,
  revokePhone,
  silencePhone,
} from "@/services/devices/phones";
import { type Actor, ServiceError, userMessage } from "@/services/kernel";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

async function run<T>(
  w: string,
  fn: (a: Actor, workspaceId: string, now: Date) => Promise<T>,
): Promise<ActionResult<T>> {
  // outside the try: requireAdmin redirects to /login by throwing
  const { actor, workspace } = await requireAdmin({ w });
  try {
    const data = await fn(actor, workspace.id, new Date());
    revalidatePath("/admin/phones");
    return data === undefined ? { ok: true } : { ok: true, data };
  } catch (e) {
    if (!(e instanceof ServiceError)) console.error("admin-phones action failed", e);
    return { ok: false, error: userMessage(e) };
  }
}

/** A form value the admin typed wrong → INVALID with the helper's message. */
function input<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw new ServiceError("INVALID", (e as Error).message);
  }
}

const blankToNull = (s: string | null) => (s?.trim() ? s.trim() : null);

export async function createPairingCodeAction(w: string, label: string) {
  return run(w, async (a, workspaceId) => {
    const r = await createPairingCode(db(), a, { workspaceId, label: blankToNull(label) });
    const qrDataUrl = await QRCode.toDataURL(r.qrUrl, { margin: 1, width: 320 });
    return { code: r.code, qrUrl: r.qrUrl, expiresIst: istHHMM(r.expiresAt), qrDataUrl };
  });
}

export async function labelPhoneAction(w: string, deviceId: string, label: string) {
  return run(w, async (a, workspaceId) => void (await labelPhone(db(), a, { workspaceId, deviceId, label })));
}

export async function assignPhoneAction(w: string, deviceId: string, vehicleId: string | null) {
  return run(w, async (a, workspaceId) => void (await assignPhone(db(), a, { workspaceId, deviceId, vehicleId })));
}

/** `until` is a datetime-local value in IST. */
export async function silencePhoneAction(w: string, deviceId: string, until: string) {
  return run(w, async (a, workspaceId) => {
    await silencePhone(db(), a, { workspaceId, deviceId, until: input(() => istInputToIso(until)) });
  });
}

export async function forceActiveAction(w: string, deviceId: string, hours: number) {
  return run(w, async (a, workspaceId, now) => {
    const until = input(() => untilFromHours(now.getTime(), hours));
    await forceActive(db(), a, { workspaceId, deviceId, until, intervalS: null });
  });
}

export async function cancelDirectiveAction(w: string, directiveId: string) {
  return run(w, (a, workspaceId) => cancelDirective(db(), a, { workspaceId, directiveId }));
}

export async function nudgePhoneAction(w: string, deviceId: string) {
  return run(w, (a, workspaceId) => nudgePhone(db(), a, { workspaceId, deviceId }));
}

export async function killPhoneAction(w: string, deviceId: string) {
  return run(w, async (a, workspaceId) => void (await killPhone(db(), a, { workspaceId, deviceId })));
}

/** Lifts a Telegram/Traccar phone's kill (they can't press Resume) and any pause of its own. */
export async function resumePhoneAction(w: string, deviceId: string) {
  return run(w, async (a, workspaceId) => void (await resumePhone(db(), a, { workspaceId, deviceId })));
}

export async function revokePhoneAction(w: string, deviceId: string) {
  return run(w, async (a, workspaceId) => void (await revokePhone(db(), a, { workspaceId, deviceId })));
}

export async function movePhoneAction(w: string, deviceId: string, toWorkspaceId: string) {
  return run(
    w,
    async (a, workspaceId) => void (await movePhoneToWorkspace(db(), a, { workspaceId, deviceId, toWorkspaceId })),
  );
}

/** Blank = stop targeting (phones keep what they run). */
export async function rolloutAction(w: string, updateId: string) {
  return run(
    w,
    async (a, workspaceId) => void (await rolloutUpdate(db(), a, { workspaceId, updateId: blankToNull(updateId) })),
  );
}

/** Blank = follow the workspace target. */
export async function phoneUpdateAction(w: string, deviceId: string, updateId: string) {
  return run(w, (a, workspaceId) =>
    setPhoneUpdate(db(), a, { workspaceId, deviceId, updateId: blankToNull(updateId) }),
  );
}
