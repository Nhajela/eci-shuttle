/** learning: leg_stats, segment_speeds, suggestions (SPEC §6a). Derived: not audited, except suggestion writes. */
import {
  distanceM,
  type EtaLeg,
  IST_OFFSET_MIN,
  type LatLng,
  type LegEstimate,
  type LegSample,
  legEstimate,
  type McpChange,
  pathLengthM,
  projectOntoPath,
} from "@eci-shuttle/shared";
import { and, between, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { Db } from "@/db";
import {
  departureMatches,
  dwells,
  learningExclusions,
  legStats,
  pings,
  routes,
  segmentSpeeds,
  services,
  serviceVehicles,
  spots,
  suggestions,
  trips,
} from "@/db/schema";
import type { LegStat, Route, Trip } from "@/db/types";
import { mutate, systemActor } from "../kernel";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;
const MIN_SAMPLES = 5;
const SEGMENT_M = 200;
const BASELINE_MPS = 25 / 3.6;
/** the timetable has no planned dwell; the day-1 baseline (legEstimate's baselineDwellS) stands in for it */
const PLANNED_DWELL_S = 180;
const LATE_SHIFT_MIN = 5;

const istMs = (ms: number) => ms + IST_OFFSET_MIN * 60_000;
const istHour = (ms: number) => new Date(istMs(ms)).getUTCHours();
const istDate = (ms: number) => new Date(istMs(ms)).toISOString().slice(0, 10);
const istHHMM = (ms: number) => new Date(istMs(ms)).toISOString().slice(11, 16);
const addMin = (hhmm: string, min: number) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = ((((h as number) * 60 + (m as number) + min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const median = (xs: number[]) => quantile(xs, 0.5);
/** lower quantile of an unweighted sample */
const quantile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)] as number;
};

type Exclusion = { date: string; serviceId: string | null };
const excluded = (ex: Exclusion[], at: Date, serviceId: string | null) => {
  // ponytail: uses the IST calendar date of the event; a 01:00 run of a night service counts as the next day
  const d = istDate(at.getTime());
  return ex.some((e) => e.date === d && (e.serviceId === null || e.serviceId === serviceId));
};

// ------------------------------------------------------------------ leg_stats

type GroupKey = { kind: "leg" | "dwell"; fromSpotId: string; toSpotId: string | null; serviceId: string | null };
const keyOf = (k: GroupKey) => `${k.kind}|${k.fromSpotId}|${k.toSpotId}|${k.serviceId}`;

/** Clean, non-excluded leg and dwell samples of the window, grouped by leg (special services on their own key). */
async function collectSamples(db: Db, workspaceId: string, now: Date, only?: GroupKey[]) {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const ex = await db.select().from(learningExclusions).where(eq(learningExclusions.workspaceId, workspaceId));
  const groups = new Map<string, { key: GroupKey; samples: LegSample[] }>();
  const add = (key: GroupKey, s: LegSample) => {
    const k = keyOf(key);
    if (only && !only.some((o) => keyOf(o) === k)) return;
    const g = groups.get(k) ?? groups.set(k, { key, samples: [] }).get(k);
    g?.samples.push(s);
  };

  const tripRows = await db
    .select({ t: trips, serviceKind: services.kind })
    .from(trips)
    .leftJoin(services, eq(services.id, trips.serviceId))
    .where(
      and(
        eq(trips.workspaceId, workspaceId),
        eq(trips.quality, "clean"),
        isNotNull(trips.toSpotId),
        isNotNull(trips.durationS),
        between(trips.departedAt, since, now),
      ),
    );
  for (const { t, serviceKind } of tripRows) {
    if (excluded(ex, t.departedAt, t.serviceId)) continue;
    const serviceId = serviceKind === "special" ? t.serviceId : null;
    add(
      { kind: "leg", fromSpotId: t.fromSpotId, toSpotId: t.toSpotId, serviceId },
      { durationS: t.durationS as number, at: t.departedAt.getTime() },
    );
  }

  const dwellRows = await db
    .select({ d: dwells, serviceKind: services.kind })
    .from(dwells)
    .leftJoin(services, eq(services.id, dwells.serviceId))
    .where(
      and(eq(dwells.workspaceId, workspaceId), isNotNull(dwells.departedAt), between(dwells.arrivedAt, since, now)),
    );
  for (const { d, serviceKind } of dwellRows) {
    if (excluded(ex, d.arrivedAt, d.serviceId)) continue;
    const serviceId = serviceKind === "special" ? d.serviceId : null;
    const durationS = ((d.departedAt as Date).getTime() - d.arrivedAt.getTime()) / 1000;
    add({ kind: "dwell", fromSpotId: d.spotId, toSpotId: null, serviceId }, { durationS, at: d.arrivedAt.getTime() });
  }

  // runs more than 3× the median are dropped (a breakdown, a detour)
  for (const g of groups.values()) {
    const m = median(g.samples.map((s) => s.durationS));
    g.samples = g.samples.filter((s) => s.durationS <= 3 * m);
  }
  return [...groups.values()];
}

/** Rewrites leg_stats rows: the whole workspace, or just the `only` groups. One all-day row + one per IST hour seen. */
async function writeLegStats(db: Db, workspaceId: string, now: Date, only?: GroupKey[]) {
  const groups = await collectSamples(db, workspaceId, now, only);
  const rows = groups.flatMap(({ key, samples }) =>
    [null, ...new Set(samples.map((s) => istHour(s.at)))].map((hourBucket) => {
      // hour -1 matches no sample, so legEstimate gives the all-day rung
      const e = legEstimate(samples, {
        hourBucket: hourBucket ?? -1,
        pathM: 0,
        now: now.getTime(),
        minSamples: MIN_SAMPLES,
      });
      return {
        workspaceId,
        ...key,
        hourBucket,
        n: e.n,
        medianS: e.medianS,
        p20S: e.p20S,
        p80S: e.p80S,
        level: e.level,
      };
    }),
  );
  await db.transaction(async (tx) => {
    const ws = eq(legStats.workspaceId, workspaceId);
    if (!only) await tx.delete(legStats).where(ws);
    for (const k of only ?? [])
      await tx
        .delete(legStats)
        .where(
          and(
            ws,
            eq(legStats.kind, k.kind),
            eq(legStats.fromSpotId, k.fromSpotId),
            k.toSpotId ? eq(legStats.toSpotId, k.toSpotId) : isNull(legStats.toSpotId),
            k.serviceId ? eq(legStats.serviceId, k.serviceId) : isNull(legStats.serviceId),
          ),
        );
    if (rows.length) await tx.insert(legStats).values(rows);
  });
}

// ------------------------------------------------------------------ route geometry

/** Where each leg of a route starts and ends along its path (metres), and the leg's own sub-path. */
async function routeLegs(db: Db, route: Route) {
  const spotRows = await db.select().from(spots).where(inArray(spots.id, route.spotIds));
  const at = (id: string) => spotRows.find((s) => s.id === id) as LatLng;
  const path = route.path;
  const idx = route.spotPathIdx;
  const hasPath = path.length >= 2 && idx.length === route.spotIds.length;
  let startM = 0;
  return route.spotIds.slice(0, -1).map((fromSpotId, i) => {
    const toSpotId = route.spotIds[i + 1] as string;
    const sub = hasPath ? path.slice(idx[i], (idx[i + 1] as number) + 1) : [at(fromSpotId), at(toSpotId)];
    const lengthM = sub.length >= 2 ? pathLengthM(sub) : distanceM(at(fromSpotId), at(toSpotId));
    const leg = { fromSpotId, toSpotId, sub, startM, lengthM, onPath: hasPath };
    startM += lengthM;
    return leg;
  });
}

// ------------------------------------------------------------------ segment_speeds

/** Rewrites one route's segment speeds from pings of its clean trips in the window. */
async function writeSegmentSpeeds(db: Db, route: Route, now: Date) {
  const legs = (await routeLegs(db, route)).filter((l) => l.onPath);
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const ex = await db.select().from(learningExclusions).where(eq(learningExclusions.workspaceId, route.workspaceId));
  const rows = await db
    .select({ trip: trips, lat: pings.lat, lng: pings.lng, at: pings.recordedAt })
    .from(trips)
    .innerJoin(
      pings,
      and(
        eq(pings.vehicleId, trips.vehicleId),
        gte(pings.recordedAt, trips.departedAt),
        lte(pings.recordedAt, trips.arrivedAt),
      ),
    )
    .where(and(eq(trips.routeId, route.id), eq(trips.quality, "clean"), between(trips.departedAt, since, now)))
    .orderBy(trips.id, pings.recordedAt);

  const speeds = new Map<string, number[]>(); // "segment|hour" → m/s
  let prev: { tripId: string; alongM: number; at: number } | null = null;
  for (const r of rows) {
    const leg = legs.find((l) => l.fromSpotId === r.trip.fromSpotId && l.toSpotId === r.trip.toSpotId);
    if (!leg || excluded(ex, r.trip.departedAt, r.trip.serviceId)) continue;
    const cur = { tripId: r.trip.id, alongM: leg.startM + projectOntoPath(leg.sub, r).alongM, at: r.at.getTime() };
    if (prev?.tripId === cur.tripId) {
      const dt = (cur.at - prev.at) / 1000;
      const mps = (cur.alongM - prev.alongM) / dt;
      if (dt > 0 && mps >= 0 && mps < 40) {
        const seg = Math.floor((prev.alongM + cur.alongM) / 2 / SEGMENT_M);
        for (const h of [null, istHour(prev.at)]) {
          const k = `${seg}|${h}`;
          (speeds.get(k) ?? speeds.set(k, []).get(k))?.push(mps);
        }
      }
    }
    prev = cur;
  }

  const totalM = legs.at(-1) ? (legs.at(-1)?.startM as number) + (legs.at(-1)?.lengthM as number) : 0;
  const values = [...speeds].map(([k, v]) => {
    const [seg, h] = k.split("|");
    const segmentIndex = Number(seg);
    return {
      workspaceId: route.workspaceId,
      routeId: route.id,
      segmentIndex,
      startM: segmentIndex * SEGMENT_M,
      endM: Math.min((segmentIndex + 1) * SEGMENT_M, totalM),
      hourBucket: h === "null" ? null : Number(h),
      n: v.length,
      medianMps: median(v),
    };
  });
  await db.transaction(async (tx) => {
    await tx.delete(segmentSpeeds).where(eq(segmentSpeeds.routeId, route.id));
    if (values.length) await tx.insert(segmentSpeeds).values(values);
  });
}

// ------------------------------------------------------------------ public API

/** Cheap incremental update when a trip closes (called after ingest): refresh that leg's stats and segment speeds. */
export async function onTripClosed(db: Db, trip: Trip, now: Date): Promise<void> {
  if (trip.quality !== "clean" || !trip.toSpotId || trip.durationS == null) return;
  const [svc] = trip.serviceId ? await db.select().from(services).where(eq(services.id, trip.serviceId)) : [];
  const serviceId = svc?.kind === "special" ? svc.id : null;
  await writeLegStats(db, trip.workspaceId, now, [
    { kind: "leg", fromSpotId: trip.fromSpotId, toSpotId: trip.toSpotId, serviceId },
    { kind: "dwell", fromSpotId: trip.fromSpotId, toSpotId: null, serviceId },
  ]);
  const [route] = trip.routeId ? await db.select().from(routes).where(eq(routes.id, trip.routeId)) : [];
  if (route) await writeSegmentSpeeds(db, route, now);
}

/**
 * Nightly (02:30 IST): recompute every leg_stats / segment_speeds row of the workspace from the last 7 service
 * days (dropping off-route / gap / > 3× median trips and excluded days; special services on their own legs),
 * refresh routes.typical_leg_s, and upsert suggestions (by dedupe_key; never touches accepted/dismissed ones).
 */
export async function recomputeAll(db: Db, workspaceId: string, now: Date): Promise<{ suggestions: number }> {
  await writeLegStats(db, workspaceId, now);
  const routeRows = await db
    .select()
    .from(routes)
    .where(and(eq(routes.workspaceId, workspaceId), isNull(routes.archivedAt)));
  for (const route of routeRows) {
    await writeSegmentSpeeds(db, route, now);
    const { legs } = await loadEstimates(db, { workspaceId, routeId: route.id, serviceId: null }, now, null);
    const typical = legs.map((l) => (l.estimate.level === "baseline" ? null : Math.round(l.estimate.medianS)));
    // derived, like the stats: no version bump, so it never invalidates an open MCP proposal
    if (JSON.stringify(typical) !== JSON.stringify(route.typicalLegS))
      await db
        .update(routes)
        .set({ typicalLegS: typical as number[] })
        .where(eq(routes.id, route.id));
  }
  const found = await findSuggestions(db, workspaceId, now, routeRows);
  await writeSuggestions(db, workspaceId, found);
  return { suggestions: found.length };
}

/** Learned estimate from leg_stats rows: the IST-hour row, else the all-day row, else the 25 km/h / 3 min baseline. */
function pick(rows: LegStat[], hour: number | null, baselineS: number): LegEstimate {
  const r =
    (hour === null ? undefined : rows.find((x) => x.hourBucket === hour)) ?? rows.find((x) => x.hourBucket === null);
  if (!r) return { medianS: baselineS, p20S: baselineS, p80S: baselineS, n: 0, level: "baseline", thin: true };
  return { medianS: r.medianS, p20S: r.p20S, p80S: r.p80S, n: r.n, level: r.level, thin: r.n < MIN_SAMPLES };
}

/**
 * What etaToSpot needs for a route at `now`: one EtaLeg per leg (legEstimate on that leg's samples for the IST
 * hour bucket, with segment speeds) and the dwell estimate per spot. Special services use their own stats.
 */
export async function loadEstimates(
  db: Db,
  input: { workspaceId: string; routeId: string; serviceId: string | null },
  now: Date,
  /** IST hour bucket to read; null = all-day rows only (nightly typical_leg_s / cycle) */
  hour: number | null = istHour(now.getTime()),
): Promise<{ legs: EtaLeg[]; dwells: Record<string, LegEstimate>; cycleS: number | null }> {
  const [route] = await db
    .select()
    .from(routes)
    .where(and(eq(routes.id, input.routeId), eq(routes.workspaceId, input.workspaceId)));
  if (!route) return { legs: [], dwells: {}, cycleS: null };
  const [svc] = input.serviceId ? await db.select().from(services).where(eq(services.id, input.serviceId)) : [];
  const serviceKey = svc?.kind === "special" ? svc.id : null;

  const stats = await db
    .select()
    .from(legStats)
    .where(
      and(
        eq(legStats.workspaceId, input.workspaceId),
        inArray(legStats.fromSpotId, route.spotIds),
        serviceKey ? eq(legStats.serviceId, serviceKey) : isNull(legStats.serviceId),
      ),
    );
  const segs = await db.select().from(segmentSpeeds).where(eq(segmentSpeeds.routeId, route.id));

  const geo = await routeLegs(db, route);
  const legs: EtaLeg[] = geo.map((g) => {
    const rows = stats.filter((s) => s.kind === "leg" && s.fromSpotId === g.fromSpotId && s.toSpotId === g.toSpotId);
    const endM = g.startM + g.lengthM;
    const segments = [...new Set(segs.map((s) => s.segmentIndex))]
      .map((i) => {
        const at = segs.filter((s) => s.segmentIndex === i);
        return at.find((s) => s.hourBucket === hour && s.n >= MIN_SAMPLES) ?? at.find((s) => s.hourBucket === null);
      })
      .filter((s) => s && s.startM < endM && s.endM > g.startM)
      .map((s) => ({
        startM: Math.max(s?.startM as number, g.startM) - g.startM,
        endM: Math.min(s?.endM as number, endM) - g.startM,
        medianMps: s?.medianMps as number,
      }))
      .sort((a, b) => a.startM - b.startM);
    return {
      fromSpotId: g.fromSpotId,
      toSpotId: g.toSpotId,
      lengthM: g.lengthM,
      estimate: pick(rows, hour, g.lengthM / BASELINE_MPS),
      ...(g.onPath && segments.length ? { segments } : {}),
    };
  });

  const loop = route.spotIds[0] === route.spotIds.at(-1);
  const stopSpots = [...new Set(loop ? route.spotIds.slice(0, -1) : route.spotIds)];
  const dwellsBySpot = Object.fromEntries(
    stopSpots.map((id) => [
      id,
      pick(
        stats.filter((s) => s.kind === "dwell" && s.fromSpotId === id),
        hour,
        PLANNED_DWELL_S,
      ),
    ]),
  );
  const cycleS = loop
    ? legs.reduce((t, l) => t + l.estimate.medianS, 0) +
      route.spotIds.slice(0, -1).reduce((t, id) => t + (dwellsBySpot[id]?.medianS ?? 0), 0)
    : null;
  return { legs, dwells: dwellsBySpot, cycleS };
}

// ------------------------------------------------------------------ suggestions

type Found = {
  kind: string;
  dedupeKey: string;
  summary: string;
  evidence: Record<string, unknown>;
  proposedChanges: McpChange[];
};

async function findSuggestions(db: Db, workspaceId: string, now: Date, routeRows: Route[]): Promise<Found[]> {
  const found: Found[] = [];
  const ex = await db.select().from(learningExclusions).where(eq(learningExclusions.workspaceId, workspaceId));
  const svcRows = await db
    .select()
    .from(services)
    .where(and(eq(services.workspaceId, workspaceId), isNull(services.archivedAt)));
  const spotRows = await db.select().from(spots).where(eq(spots.workspaceId, workspaceId));
  const spotName = (id: string) => spotRows.find((s) => s.id === id)?.name ?? "a spot";

  // 1. a planned departure that leaves late, on average, by 5+ min: shift it ("times" patterns, first spot only)
  const matches = await db
    .select()
    .from(departureMatches)
    .where(
      and(
        eq(departureMatches.workspaceId, workspaceId),
        eq(departureMatches.missed, false),
        isNotNull(departureMatches.delayMin),
        between(departureMatches.plannedAt, new Date(now.getTime() - WINDOW_DAYS * DAY_MS), now),
      ),
    );
  const bySlot = new Map<string, { serviceId: string; spotId: string; planned: string; delays: number[] }>();
  for (const m of matches) {
    if (ex.some((e) => e.date === m.date && (e.serviceId === null || e.serviceId === m.serviceId))) continue;
    const planned = istHHMM(m.plannedAt.getTime());
    const k = `shift:${m.serviceId}:${m.spotId}:${planned}`;
    const slot =
      bySlot.get(k) ?? bySlot.set(k, { serviceId: m.serviceId, spotId: m.spotId, planned, delays: [] }).get(k);
    slot?.delays.push(m.delayMin as number);
  }
  for (const [dedupeKey, s] of bySlot) {
    const svc = svcRows.find((x) => x.id === s.serviceId);
    const route = routeRows.find((r) => r.id === svc?.routeId);
    if (svc?.pattern.kind !== "times" || route?.spotIds[0] !== s.spotId || s.delays.length < MIN_SAMPLES) continue;
    const avg = s.delays.reduce((a, b) => a + b, 0) / s.delays.length;
    const shiftMin = Math.round(avg / 5) * 5;
    if (avg < LATE_SHIFT_MIN || !shiftMin) continue;
    const to = addMin(s.planned, shiftMin);
    const times = svc.pattern.times.map((t) => (t === s.planned ? to : t)).sort();
    const p80 = quantile(s.delays, 0.8);
    const r1 = (x: number) => Math.round(x * 10) / 10;
    found.push({
      kind: "shift_departure",
      dedupeKey,
      summary: `The ${s.planned} from ${spotName(s.spotId)} left on average ${r1(avg)} min late (p80 ${r1(p80)}, n=${s.delays.length}). Shift it to ${to}?`,
      evidence: {
        serviceId: svc.id,
        spotId: s.spotId,
        planned: s.planned,
        n: s.delays.length,
        avgDelayMin: r1(avg),
        p80DelayMin: r1(p80),
        shiftMin,
      },
      proposedChanges: [
        { kind: "service.update", serviceId: svc.id, version: svc.version, pattern: { kind: "times", times } },
      ],
    });
  }

  // 2. "every N min" that the assigned vehicles can't run: one loop takes longer than N × vehicles
  for (const svc of svcRows) {
    if (svc.pattern.kind !== "every") continue;
    const assigned = await db
      .selectDistinct({ v: serviceVehicles.vehicleId })
      .from(serviceVehicles)
      .where(
        and(
          eq(serviceVehicles.serviceId, svc.id),
          gte(serviceVehicles.endsAt, new Date(now.getTime() - WINDOW_DAYS * DAY_MS)),
        ),
      );
    const { legs, cycleS } = await loadEstimates(
      db,
      { workspaceId, routeId: svc.routeId, serviceId: svc.id },
      now,
      null,
    );
    if (!assigned.length || cycleS === null || legs.some((l) => l.estimate.level === "baseline")) continue;
    const cycleMin = Math.round(cycleS / 60);
    const needMin = cycleMin / assigned.length;
    if (needMin <= svc.pattern.everyMin) continue;
    const suggestedEveryMin = Math.min(240, Math.ceil(needMin / 5) * 5);
    const one = assigned.length === 1 ? "one vehicle" : `${assigned.length} vehicles`;
    found.push({
      kind: "change_frequency",
      dedupeKey: `frequency:${svc.id}`,
      summary: `A loop of ${svc.name} takes ${cycleMin} min, but the timetable needs one every ${svc.pattern.everyMin} with ${one}. Change to every ${suggestedEveryMin}, or add a vehicle.`,
      evidence: {
        serviceId: svc.id,
        cycleMin,
        vehicles: assigned.length,
        everyMin: svc.pattern.everyMin,
        suggestedEveryMin,
        legN: legs.map((l) => l.estimate.n),
      },
      proposedChanges: [
        {
          kind: "service.update",
          serviceId: svc.id,
          version: svc.version,
          pattern: { kind: "every", everyMin: suggestedEveryMin },
        },
      ],
    });
  }

  // 3. dwell far over the planned 3 min (all regular services; informational, nothing to propose)
  const dwellRows = await db
    .select()
    .from(legStats)
    .where(
      and(
        eq(legStats.workspaceId, workspaceId),
        eq(legStats.kind, "dwell"),
        isNull(legStats.hourBucket),
        isNull(legStats.serviceId),
      ),
    );
  for (const d of dwellRows) {
    if (d.n < MIN_SAMPLES || d.medianS < 2 * PLANNED_DWELL_S) continue;
    const medianMin = Math.round(d.medianS / 60);
    found.push({
      kind: "dwell_mismatch",
      dedupeKey: `dwell:${d.fromSpotId}`,
      summary: `Dwell at ${spotName(d.fromSpotId)} is ${medianMin} min on average, against ${PLANNED_DWELL_S / 60} min planned.`,
      evidence: {
        spotId: d.fromSpotId,
        medianMin,
        p80Min: Math.round(d.p80S / 60),
        plannedMin: PLANNED_DWELL_S / 60,
        n: d.n,
      },
      proposedChanges: [],
    });
  }
  return found;
}

/** Upsert by dedupe key (audited), leaving accepted/dismissed ones alone; open ones that no longer apply go. */
async function writeSuggestions(db: Db, workspaceId: string, found: Found[]) {
  const actor = systemActor("learning");
  const existing = await db.select().from(suggestions).where(eq(suggestions.workspaceId, workspaceId));
  for (const f of found) {
    const old = existing.find((e) => e.dedupeKey === f.dedupeKey);
    if (old && old.status !== "open") continue;
    if (
      old &&
      JSON.stringify([old.summary, old.evidence, old.proposedChanges]) ===
        JSON.stringify([f.summary, f.evidence, f.proposedChanges])
    )
      continue;
    await mutate(
      db,
      actor,
      { action: old ? "suggestion.update" : "suggestion.create", entity: "suggestion", workspaceId },
      async (tx) => {
        const [row] = old
          ? await tx
              .update(suggestions)
              .set({ ...f, updatedAt: new Date() })
              .where(eq(suggestions.id, old.id))
              .returning()
          : await tx
              .insert(suggestions)
              .values({ workspaceId, ...f })
              .returning();
        return { before: old ?? null, after: row, result: row };
      },
    );
  }
  const stale = existing.filter((e) => e.status === "open" && !found.some((f) => f.dedupeKey === e.dedupeKey));
  for (const s of stale)
    await mutate(
      db,
      actor,
      { action: "suggestion.expire", entity: "suggestion", entityId: s.id, workspaceId },
      async (tx) => {
        await tx.delete(suggestions).where(eq(suggestions.id, s.id));
        return { before: s, after: null, result: null };
      },
    );
}
