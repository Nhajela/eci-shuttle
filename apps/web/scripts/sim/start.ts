/** The sim's setup and its one hard rule (SPEC §3): never pair, assign or replay in the live workspace. */
import { GEOFENCE_DWELL_S } from "@eci-shuttle/shared";
import type { SimArgs } from "./args";
import { pairSim, runSim, type SimDeps, type SimEnd } from "./device";
import { buildPlan } from "./plan";

type Ws = { id: string; slug: string; isLive: boolean };

/** The services the sim calls, already bound to the DB and the "sim" system actor (so they're audited). */
export type SimServices = {
  workspaceBySlug: (slug: string) => Promise<Ws | null>;
  listRoutes: (workspaceId: string) => Promise<(Parameters<typeof buildPlan>[0] & { name: string })[]>;
  listVehicles: (workspaceId: string) => Promise<{ id: string; name: string }[]>;
  assignPhone: (input: { workspaceId: string; deviceId: string; vehicleId: string }) => Promise<unknown>;
  revokePhone: (input: { workspaceId: string; deviceId: string }) => Promise<unknown>;
};

export async function startSim(
  args: SimArgs,
  o: { origin: string; services: SimServices; deps: SimDeps; signal?: AbortSignal },
): Promise<SimEnd> {
  const { services: svc, deps } = o;
  const ws = await svc.workspaceBySlug(args.slug);
  if (!ws) throw new Error(`No workspace "${args.slug}".`);
  if (ws.isLive) throw new Error("Simulated phones only run in test workspaces, never in the live one.");
  const routes = await svc.listRoutes(ws.id);
  const route = args.route ? routes.find((r) => r.name === args.route) : routes[0];
  if (!route) throw new Error(args.route ? `No route "${args.route}" in ${ws.slug}.` : `${ws.slug} has no routes yet.`);
  const vehicle = (await svc.listVehicles(ws.id)).find((v) => v.name === args.vehicle);
  if (!vehicle) throw new Error(`No vehicle "${args.vehicle}" in ${ws.slug}.`);

  const paired = await pairSim(o.origin, args.code, deps);
  if (paired.config.workspace.slug !== ws.slug || paired.config.workspace.isLive) {
    // the code was made in another workspace (maybe live): undo the pairing so no stray sim sits there
    const other = await svc.workspaceBySlug(paired.config.workspace.slug);
    if (other) await svc.revokePhone({ workspaceId: other.id, deviceId: paired.deviceId });
    throw new Error(
      `That code belongs to "${paired.config.workspace.slug}", not "${ws.slug}". Its pairing was undone.`,
    );
  }
  await svc.assignPhone({ workspaceId: ws.id, deviceId: paired.deviceId, vehicleId: vehicle.id });

  // a spot only counts as reached after GEOFENCE_DWELL_S of real time inside it, so long dwells survive Nx
  const plan = buildPlan(route, { dwellS: Math.max(120, (GEOFENCE_DWELL_S + 20) * args.speed), kmh: 25 });
  deps.log(
    `Paired into ${ws.slug} as ${vehicle.name} on "${route.name}" at ${args.speed}x ` +
      `(one cycle ≈ ${Math.round(plan.totalS / args.speed / 60)} min). Ctrl+C to stop.`,
  );
  return runSim({
    origin: o.origin,
    token: paired.token,
    config: paired.config,
    plan,
    speed: args.speed,
    deps,
    signal: o.signal,
  });
}
