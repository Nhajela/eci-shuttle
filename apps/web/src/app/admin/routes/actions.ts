"use server";
/** admin-routes server actions: parse the form, build the Actor (ops+), call services/catalog/routes, map errors. */
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { parsePath } from "@/components/admin/routes/routes";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { createRoute, updateRoute } from "@/services/catalog/routes";
import { type Actor, isServiceError, userMessage } from "@/services/kernel";

export type ActionState = { ok: boolean; message: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const num = (fd: FormData, k: string) => (fd.has(k) ? Number(fd.get(k)) : undefined);

async function run(
  fd: FormData,
  done: string,
  fn: (actor: Actor, workspaceId: string) => Promise<unknown>,
): Promise<ActionState> {
  try {
    const { actor, workspace } = await requireAdmin({ w: str(fd, "w") || null, minRole: "ops" });
    await fn(actor, workspace.id);
  } catch (e) {
    unstable_rethrow(e); // requireAdmin's redirects
    if (!isServiceError(e)) console.error("admin-routes action failed", e);
    return { ok: false, message: userMessage(e) };
  }
  revalidatePath("/admin/routes");
  return { ok: true, message: done };
}

export async function createRouteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, "Route created.", (actor, workspaceId) =>
    createRoute(db(), actor, { workspaceId, name: str(fd, "name"), spotIds: fd.getAll("spotId").map(String) }),
  );
}

export async function updateRouteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, "Route saved.", (actor, workspaceId) =>
    updateRoute(db(), actor, {
      workspaceId,
      routeId: str(fd, "routeId"),
      version: num(fd, "version"),
      name: str(fd, "name"),
      // the form sends spots only when they changed: a rename must not regenerate the path or trip on archived spots
      ...(fd.has("spotId") && { spotIds: fd.getAll("spotId").map(String) }),
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
