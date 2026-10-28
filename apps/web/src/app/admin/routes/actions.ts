"use server";
/** admin-routes server actions: parse the form, build the Actor (ops+), call services/catalog/routes, map errors. */
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { parsePath, parseWaits } from "@/components/admin/routes/routes";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { createRoute, updateRoute } from "@/services/catalog/routes";
import { type Actor, isServiceError, userMessage } from "@/services/kernel";
import { setLegNoSignal } from "@/services/signal/dead-zones";

export type ActionState = { ok: boolean; message: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const num = (fd: FormData, k: string) => (fd.has(k) ? Number(fd.get(k)) : undefined);

async function run(
  fd: FormData,
  done: string | ((result: unknown) => string),
  fn: (actor: Actor, workspaceId: string) => Promise<unknown>,
  minRole: "ops" | "admin" = "ops",
): Promise<ActionState> {
  let result: unknown;
  try {
    const { actor, workspace } = await requireAdmin({ w: str(fd, "w") || null, minRole });
    result = await fn(actor, workspace.id);
  } catch (e) {
    unstable_rethrow(e); // requireAdmin's redirects
    if (!isServiceError(e)) console.error("admin-routes action failed", e);
    return { ok: false, message: userMessage(e) };
  }
  revalidatePath("/admin/routes");
  return { ok: true, message: typeof done === "function" ? done(result) : done };
}

export async function createRouteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, "Route created.", (actor, workspaceId) =>
    createRoute(db(), actor, { workspaceId, name: str(fd, "name"), spotIds: fd.getAll("spotId").map(String) }),
  );
}

/** "Route saved.", plus how many hand-made "no signal" marks the new stops could not keep. */
const savedMessage = (r: unknown) => {
  const n = (r as { droppedNoSignalLegs?: number } | null)?.droppedNoSignalLegs ?? 0;
  return n
    ? `Route saved. ${n} "no signal" ${n === 1 ? "mark was" : "marks were"} removed because ${n === 1 ? "that stretch is" : "those stretches are"} no longer on the route. Check the legs below.`
    : "Route saved.";
};

export async function updateRouteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const waits = parseWaits(fd);
  return run(fd, savedMessage, (actor, workspaceId) =>
    updateRoute(db(), actor, {
      workspaceId,
      routeId: str(fd, "routeId"),
      version: num(fd, "version"),
      name: str(fd, "name"),
      // the form sends spots only when they changed: a rename must not regenerate the path or trip on archived spots
      ...(fd.has("spotId") && { spotIds: fd.getAll("spotId").map(String) }),
      ...(waits && { plannedDwellS: waits }),
    }),
  );
}

export async function savePathAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const path = parsePath(fd.get("path"));
  if (!path) return { ok: false, message: "The edited path couldn't be read. Reload and try again." };
  return run(fd, "Path saved.", (actor, workspaceId) =>
    updateRoute(db(), actor, { workspaceId, routeId: str(fd, "routeId"), version: num(fd, "version"), path }),
  );
}

export async function regeneratePathAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, "Path regenerated from the road map.", (actor, workspaceId) =>
    updateRoute(db(), actor, {
      workspaceId,
      routeId: str(fd, "routeId"),
      version: num(fd, "version"),
      regeneratePath: true,
    }),
  );
}

/**
 * Admin only: set a leg's signal state. `mode` = auto | no_signal | has_signal (three-state control); the older
 * `noSignal` 1/0 form still works (1 = no_signal, 0 = auto).
 */
export async function setLegNoSignalAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const raw = str(fd, "mode");
  const mode = raw === "auto" || raw === "no_signal" || raw === "has_signal" ? raw : undefined;
  const noSignal = str(fd, "noSignal") === "1";
  const effective = mode ?? (noSignal ? "no_signal" : "auto");
  return run(
    fd,
    effective === "no_signal"
      ? "Marked as no signal."
      : effective === "has_signal"
        ? "Marked as having signal."
        : mode
          ? "Back to automatic."
          : "Signal restored.",
    (actor, workspaceId) =>
      setLegNoSignal(db(), actor, {
        workspaceId,
        routeId: str(fd, "routeId"),
        version: num(fd, "version"),
        legIndex: Number(fd.get("legIndex")),
        ...(mode ? { mode } : { noSignal }),
      }),
    "admin",
  );
}
