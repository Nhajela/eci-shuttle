/**
 * sim: `pnpm sim <workspace-slug> "<vehicle>" <code> [--speed N] [--origin URL] [--route NAME]` (SPEC §3).
 * A simulated phone: pairs with a code made in admin (Workspaces → Start simulated phone), assigns itself to the
 * vehicle, then replays the workspace's route through the real POST /api/device/sync at 1x or Nx, following the
 * phone's schedule. Refuses the live workspace (see sim/start.ts). Services run as the "sim" system actor.
 */
import { db } from "@/db";
import { env } from "@/lib/env";
import { listRoutes } from "@/services/catalog/routes";
import { listVehicles } from "@/services/catalog/vehicles";
import { workspaceBySlug } from "@/services/catalog/workspaces";
import { assignPhone, revokePhone } from "@/services/devices/phones";
import { systemActor } from "@/services/kernel";
import { parseSimArgs } from "./sim/args";
import { startSim } from "./sim/start";

const database = db();
const actor = systemActor("sim");
const ctrl = new AbortController();
process.on("SIGINT", () => ctrl.abort());

const args = Promise.resolve().then(() => parseSimArgs(process.argv.slice(2)));

args
  .then((a) =>
    startSim(a, {
      origin: a.origin ?? env.origin(),
      signal: ctrl.signal,
      services: {
        workspaceBySlug: (slug) => workspaceBySlug(database, slug),
        listRoutes: (workspaceId) => listRoutes(database, actor, { workspaceId }),
        listVehicles: (workspaceId) => listVehicles(database, actor, { workspaceId }),
        assignPhone: (input) => assignPhone(database, actor, input),
        revokePhone: (input) => revokePhone(database, actor, input),
      },
      deps: {
        fetch,
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log: (line) => console.log(line),
      },
    }),
  )
  .then(
    (end) => {
      console.log(`Sim ended: ${end}.`);
      process.exit(end === "stopped" ? 0 : 1);
    },
    (e: Error) => {
      console.error(e.message);
      process.exit(1);
    },
  );
