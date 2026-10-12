import type { Window } from "@eci-shuttle/shared";
import { workspaces } from "@/db/schema";
import { bumpConfigs, desiredConfig } from "@/services/devices/config";
import { listPhones } from "@/services/devices/phones";
import { refreshPhases } from "@/services/ingest/ingest";
import { mutate, systemActor } from "@/services/kernel";
import type { Job } from "../job";

const TICK_MS = 60_000;
const actor = systemActor("windows");

/** Pure: does any window start or end in (from, to]? (Silences count: they flip the mode too.) */
export const edgeIn = (schedule: Window[], from: number, to: number) =>
  schedule.some((w) => (w.startsAt > from && w.startsAt <= to) || (w.endsAt > from && w.endsAt <= to));

/**
 * Every minute (SPEC §2b): service windows opening and closing. For each workspace, vehicles whose tracking
 * window (trackingWindows over service_vehicles ±15 min, plus directives) opened or closed in the last minute:
 * devices/config.bumpConfigs for their phones (config bump + push "sync now") and ingest.refreshPhases (on/off
 * duty). Phones also switch on their own (resolveMode on the stored config); this makes the server side and
 * phones without a fresh config catch up.
 */
export const windows: Job = {
  name: "windows",
  schedule: "* * * * *",
  run: async ({ db, now }) => {
    const prev = new Date(now.getTime() - TICK_MS);
    // ponytail: no service lists every workspace yet (contract request: catalog listAllWorkspaces)
    const all = await db.select({ id: workspaces.id }).from(workspaces);
    const errors: string[] = [];
    let bumped = 0;
    for (const { id: workspaceId } of all) {
      try {
        const deviceIds: string[] = [];
        for (const { device, vehicle } of await listPhones(db, actor, { workspaceId }, now)) {
          if (!vehicle || device.revokedAt) continue;
          // read as of a minute ago, so a window that closed since is still in the schedule
          const c = await desiredConfig(db, device.id, prev);
          if (!c.killed && !c.revoked && edgeIn(c.schedule, prev.getTime(), now.getTime())) deviceIds.push(device.id);
        }
        if (deviceIds.length) {
          bumped += (
            await mutate(db, actor, { action: "device.config_bump", entity: "device", workspaceId }, async (tx) => ({
              before: null,
              after: { deviceIds },
              result: await bumpConfigs(tx, { deviceIds }, "window"),
            }))
          ).length;
        }
        await refreshPhases(db, workspaceId, now);
      } catch (e) {
        errors.push(`${workspaceId}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (errors.length) throw new Error(`windows failed for ${errors.join("; ")}`);
    return { workspaces: all.length, bumped };
  },
};
