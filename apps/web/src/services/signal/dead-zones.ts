/**
 * svc-signal: legs of a route with no mobile signal ("dead zones"), e.g. Circle ↔ Namaka.
 * Shared interface for three parallel workstreams (owner of the implementation: the detection workstream):
 * - detection: fills `loadDeadZones` from data (Android pings that arrived late: received_at − recorded_at) plus
 *   admin overrides, and learns the leg's travel time from trips whose fixes were backfilled.
 * - prediction: services/public (sight / status / positions) consumes `loadDeadZones` + `predictAlong`.
 * - client: renders a PublicVehicle whose `estimate` is set as a faded, "no signal" van.
 *
 * Storage: `routes.no_signal_legs` (jsonb): `manual` entries (admin toggle, `setLegNoSignal`) and `detected` stretches
 * (the nightly learning job, `recomputeDeadZones` in ./recompute). `loadDeadZones` is one cheap query over that
 * column, so it is safe on the public request paths; detection over pings never runs per request.
 */
import { withWorkspace } from "@eci-shuttle/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { type NoSignalLeg, routes } from "@/db/schema";
import type { Route } from "@/db/types";
import { type Actor, checkVersion, getInWorkspace, mutate, parseInput, requireRole, ServiceError } from "../kernel";

/**
 * A stored entry as this module writes it. `noSignal: false` on a manual entry is the admin's "this leg HAS signal"
 * override: it wins over detected stretches and the nightly job never re-adds one. The field lives in the existing
 * jsonb; `NoSignalLeg` (frozen schema.ts) does not declare it yet (contract request: add `noSignal?: boolean`).
 */
export type ManualLeg = NoSignalLeg & { noSignal?: boolean };

/** True for the admin's "has signal" override entry. */
export const isHasSignalMark = (e: NoSignalLeg): boolean =>
  e.source === "manual" && (e as ManualLeg).noSignal === false;

/** One leg of a route (route.spotIds[legIndex] → route.spotIds[legIndex + 1]) known to have no signal. */
export type DeadZone = {
  routeId: string;
  /** index k: the leg from spotIds[k] to spotIds[k + 1] */
  legIndex: number;
  fromSpotId: string;
  toSpotId: string;
  /** metres along the route path where the no-signal stretch starts / ends (within the leg); null = whole leg */
  startAlongM: number | null;
  endAlongM: number | null;
  /** "manual" = marked by an admin; "detected" = found from late-arriving pings */
  source: "manual" | "detected";
  /** typical travel time of the whole leg in seconds (learned; null = unknown → use the leg estimate) */
  typicalLegS: number | null;
};

/**
 * The dead zones of one route: per leg, the manual entry if there is one (it wins: a whole-leg zone, or none for an
 * admin's "has signal" override), else the detected stretches. Entries of legs that no longer exist are dropped. Pure.
 */
export function deadZonesOf(route: Pick<Route, "id" | "spotIds" | "noSignalLegs" | "typicalLegS">): DeadZone[] {
  const out: DeadZone[] = [];
  const legs = route.spotIds.length - 1;
  for (let legIndex = 0; legIndex < legs; legIndex++) {
    const here = route.noSignalLegs.filter((e) => e.legIndex === legIndex);
    const manual = here.find((e) => e.source === "manual");
    // manual wins: "no signal" = the whole leg, "has signal" = nothing (detected stretches are suppressed)
    const chosen = manual ? (isHasSignalMark(manual) ? [] : [manual]) : here.filter((e) => e.source === "detected");
    for (const e of chosen)
      out.push({
        routeId: route.id,
        legIndex,
        fromSpotId: route.spotIds[legIndex] as string,
        toSpotId: route.spotIds[legIndex + 1] as string,
        startAlongM: e.source === "manual" ? null : (e.startAlongM ?? null),
        endAlongM: e.source === "manual" ? null : (e.endAlongM ?? null),
        source: e.source,
        // routes.typical_leg_s is the nightly learning's per-leg median of clean trips (Android trips whose fixes
        // were backfilled count as clean); null = not learned
        typicalLegS: route.typicalLegS[legIndex] ?? null,
      });
  }
  return out;
}

/** Dead zones of every route in a workspace. No actor: callers check access (public read is fine). One query. */
export async function loadDeadZones(db: Db, workspaceId: string): Promise<DeadZone[]> {
  const rows = await db
    .select({
      id: routes.id,
      spotIds: routes.spotIds,
      noSignalLegs: routes.noSignalLegs,
      typicalLegS: routes.typicalLegS,
    })
    .from(routes)
    .where(
      and(eq(routes.workspaceId, workspaceId), isNull(routes.archivedAt), sql`${routes.noSignalLegs} <> '[]'::jsonb`),
    );
  return rows.flatMap(deadZonesOf);
}

export const LEG_SIGNAL_MODES = ["auto", "no_signal", "has_signal"] as const;
export type LegSignalMode = (typeof LEG_SIGNAL_MODES)[number];

export const SetLegNoSignalInput = withWorkspace(
  z
    .object({
      routeId: z.string().uuid(),
      legIndex: z.number().int().min(0).max(19),
      /** auto = no manual entry (detection decides); no_signal / has_signal = the admin's override */
      mode: z.enum(LEG_SIGNAL_MODES).optional(),
      /** legacy two-state form: true = no_signal, false = auto. `mode` wins when both are given. */
      noSignal: z.boolean().optional(),
      version: z.number().int().optional(),
    })
    .refine((v) => v.mode !== undefined || v.noSignal !== undefined, { message: "Say which signal state to set." }),
);

/**
 * admin. Sets the signal state of a whole leg: `no_signal` (manual whole-leg zone), `has_signal` (override that
 * suppresses a wrong detected stretch) or `auto` (no manual entry; detection decides). Only the manual entry changes;
 * detected stretches stay stored. INVALID when the route has no such leg. Bumps version, audited as `route.no_signal`.
 */
export async function setLegNoSignal(
  db: Db,
  actor: Actor,
  input: z.input<typeof SetLegNoSignalInput>,
  now: Date = new Date(),
): Promise<Route> {
  const parsed = parseInput(SetLegNoSignalInput, input);
  const { workspaceId, routeId, legIndex, version } = parsed;
  const mode: LegSignalMode = parsed.mode ?? (parsed.noSignal ? "no_signal" : "auto");
  requireRole(actor, workspaceId, "admin");
  return mutate(
    db,
    actor,
    { action: "route.no_signal", entity: "route", entityId: routeId, workspaceId },
    async (tx) => {
      const before = await getInWorkspace(tx, routes, workspaceId, routeId, "route", { forUpdate: true });
      checkVersion(before, version, "route");
      if (legIndex >= before.spotIds.length - 1)
        throw new ServiceError("INVALID", "This route has no such leg.", { legIndex, legs: before.spotIds.length - 1 });
      const others = before.noSignalLegs.filter((e) => !(e.legIndex === legIndex && e.source === "manual"));
      const mark: ManualLeg | null =
        mode === "no_signal"
          ? { legIndex, source: "manual" }
          : mode === "has_signal"
            ? { legIndex, source: "manual", noSignal: false }
            : null;
      const next: NoSignalLeg[] = mark ? [...others, mark] : others;
      next.sort((a, b) => a.legIndex - b.legIndex || (a.startAlongM ?? 0) - (b.startAlongM ?? 0));
      const [after] = await tx
        .update(routes)
        .set({ noSignalLegs: next, version: before.version + 1, updatedAt: now })
        .where(eq(routes.id, routeId))
        .returning();
      return { before, after, result: after as Route };
    },
  );
}
