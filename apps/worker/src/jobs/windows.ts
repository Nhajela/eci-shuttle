import type { Window } from "@eci-shuttle/shared";
import { listAllWorkspaces } from "@/services/catalog/workspaces";
import { bumpConfigs, desiredConfig } from "@/services/devices/config";
import { listPhones } from "@/services/devices/phones";
import { refreshPhases } from "@/services/ingest/ingest";
import { mutate, systemActor } from "@/services/kernel";
import type { Job } from "../job";

const TICK_MS = 60_000;
const CATCH_UP_MS = 15 * 60_000; // past this, phones' own idle heartbeat has caught up anyway
const actor = systemActor("windows");
/** End of the last fully scanned range; ranges run end to end so skipped ticks are caught up. */
let lastTo: number | undefined;

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
    const to = Math.floor(now.getTime() / TICK_MS) * TICK_MS;
    // a cursor at or past `to` (same-minute rerun, clock step back) falls back to one tick
    const from = lastTo !== undefined && lastTo < to ? Math.max(lastTo, to - CATCH_UP_MS) : to - TICK_MS;
    const prev = new Date(from);
    const all = await listAllWorkspaces(db);
    const errors: string[] = [];
    let bumped = 0;
    for (const { id: workspaceId } of all) {
      try {
        const deviceIds: string[] = [];
        for (const { device, vehicle } of await listPhones(db, actor, { workspaceId }, now)) {
          if (!vehicle || device.revokedAt) continue;
          // read as of the range start, so a window that closed since is still in the schedule
          const c = await desiredConfig(db, device.id, prev);
          if (!c.killed && !c.revoked && edgeIn(c.schedule, from, to)) deviceIds.push(device.id);
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
    // on error the cursor stays put, so the failed workspace is retried over the same range next tick
    if (errors.length) throw new Error(`windows failed for ${errors.join("; ")}`);
    lastTo = to;
    return { workspaces: all.length, bumped };
  },
};
