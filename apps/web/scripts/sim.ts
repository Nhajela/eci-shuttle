/**
 * sim: `pnpm sim <workspace-slug> "<vehicle>" <code> [--speed N] [--origin URL] [--route NAME]` (SPEC §3).
 * A simulated phone: pairs with a code made in admin (Workspaces → Start simulated phone), assigns itself to the
 * vehicle, then replays the workspace's route through the real POST /api/device/sync at 1x or Nx. Refuses the
 * live workspace. Reads the route and vehicle, and assigns, through services (audited as the "sim" system actor).
 */
import { GEOFENCE_DWELL_S } from "@eci-shuttle/shared";
import { db } from "@/db";
import { env } from "@/lib/env";
import { listRoutes } from "@/services/catalog/routes";
import { listVehicles } from "@/services/catalog/vehicles";
import { workspaceBySlug } from "@/services/catalog/workspaces";
import { assignPhone, revokePhone } from "@/services/devices/phones";
import { systemActor } from "@/services/kernel";
import { parseSimArgs } from "./sim/args";
import { pairSim, runSim, type SimDeps } from "./sim/device";
import { buildPlan } from "./sim/plan";

const deps: SimDeps = {
  fetch,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (line) => console.log(line),
};

async function main(): Promise<number> {
  const args = parseSimArgs(process.argv.slice(2));
  const origin = args.origin ?? env.origin();
  const database = db();
  const actor = systemActor("sim");

  const ws = await workspaceBySlug(database, args.slug);
  if (!ws) throw new Error(`No workspace "${args.slug}".`);
  if (ws.isLive) throw new Error("Simulated phones only run in test workspaces, never in the live one.");
  const routes = await listRoutes(database, actor, { workspaceId: ws.id });
  const route = args.route ? routes.find((r) => r.name === args.route) : routes[0];
  if (!route) throw new Error(args.route ? `No route "${args.route}" in ${ws.slug}.` : `${ws.slug} has no routes yet.`);
  const vehicle = (await listVehicles(database, actor, { workspaceId: ws.id })).find((v) => v.name === args.vehicle);
  if (!vehicle) throw new Error(`No vehicle "${args.vehicle}" in ${ws.slug}.`);

  const paired = await pairSim(origin, args.code, deps);
  if (paired.config.workspace.slug !== ws.slug || paired.config.workspace.isLive) {
    // the code was made in another workspace (maybe live): undo the pairing so no stray sim sits there
    const other = await workspaceBySlug(database, paired.config.workspace.slug);
    if (other) await revokePhone(database, actor, { workspaceId: other.id, deviceId: paired.deviceId });
    throw new Error(
      `That code belongs to "${paired.config.workspace.slug}", not "${ws.slug}". Its pairing was undone.`,
    );
  }
  await assignPhone(database, actor, { workspaceId: ws.id, deviceId: paired.deviceId, vehicleId: vehicle.id });

  // a spot only counts as reached after GEOFENCE_DWELL_S of real time inside it, so long dwells survive Nx
  const plan = buildPlan(route, { dwellS: Math.max(120, (GEOFENCE_DWELL_S + 20) * args.speed), kmh: 25 });
  deps.log(
    `Paired into ${ws.slug} as ${vehicle.name} on "${route.name}" at ${args.speed}x ` +
      `(one cycle ≈ ${Math.round(plan.totalS / args.speed / 60)} min). Ctrl+C to stop.`,
  );
  const ctrl = new AbortController();
  process.on("SIGINT", () => ctrl.abort());
  const end = await runSim({
    origin,
    token: paired.token,
    config: paired.config,
    plan,
    speed: args.speed,
    deps,
    signal: ctrl.signal,
  });
  deps.log(`Sim ended: ${end}.`);
  return end === "stopped" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(e.message);
    process.exit(1);
  },
);
