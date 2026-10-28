/**
 * svc-public: the map logged-in staff (any member: viewer+) see on the main page under the answer: spots, route
 * paths and each active vehicle's last position (none once it's over 15 min old), like the Live board's map. Attendees never get this.
 * A vehicle silent in a leg with no mobile signal is placed where it probably is, with `estimated: true`.
 */
import { type LatLng, mapPin } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import { activeBreaks } from "../catalog/breaks";
import { listRoutes } from "../catalog/routes";
import { listSpots } from "../catalog/spots";
import { listVehicles } from "../catalog/vehicles";
import { vehicleStates } from "../ingest/ingest";
import type { Actor } from "../kernel";
import { estimateVehicles } from "./estimates";

export type StaffMap = {
  spots: { id: string; name: string; lat: number; lng: number; radiusM: number }[];
  paths: LatLng[][];
  /** `estimated`: no signal on this stretch of the route; the position is a guess from the last fix (shown dashed) */
  markers: {
    id: string;
    name: string;
    colour: string | null;
    lat: number;
    lng: number;
    problem: boolean;
    estimated?: true;
  }[];
};

/** viewer+ (listVehicles checks). */
export async function staffMap(db: Db, actor: Actor, input: { workspaceId: string }, now: Date): Promise<StaffMap> {
  const { workspaceId } = input;
  const vs = await listVehicles(db, actor, { workspaceId });
  const [states, spotRows, routeRows, breaks] = await Promise.all([
    vehicleStates(db, workspaceId),
    listSpots(db, actor, { workspaceId }),
    listRoutes(db, actor, { workspaceId }),
    activeBreaks(db, workspaceId, now),
  ]);
  const stateOf = new Map(states.map((s) => [s.vehicleId, s]));
  // silent in a leg with no mobile signal: ops see where it probably is, marked as an estimate
  const guesses = await estimateVehicles(db, workspaceId, states, now);
  return {
    spots: spotRows.map((s) => ({ id: s.id, name: s.shortName, lat: s.lat, lng: s.lng, radiusM: s.radiusM })),
    paths: routeRows.filter((r) => !r.archivedAt).map((r) => r.path),
    markers: vs.flatMap((v) => {
      const s = stateOf.get(v.id);
      const guess = guesses.get(v.id);
      const name = breaks.has(v.id) ? `${v.name} · on break` : v.name;
      if (v.active && s && guess)
        return [
          {
            id: v.id,
            name,
            colour: v.colour,
            lat: guess.lat,
            lng: guess.lng,
            problem: false,
            estimated: true as const,
          },
        ];
      const pin = mapPin(s, now.getTime());
      if (!v.active || !s || !pin) return [];
      return [{ id: v.id, name, colour: v.colour, ...pin, problem: s.offRoute || s.phase === "offline" }];
    }),
  };
}
