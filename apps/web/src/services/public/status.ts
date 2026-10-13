/**
 * svc-public: the attendee answer (SPEC §6, §6a.2–4). No login; no actor. Shared by /api/status, the public
 * page, the bot's /shuttle and arrival alerts, and MCP shuttle_public_answer.
 * Never exposes lateness: no "late", no planned-vs-expected.
 */
import {
  type AnswerLine,
  type EtaLeg,
  type EtaVehicle,
  etaToSpot,
  expandServiceDepartures,
  istDate,
  istHHMM,
  istToEpoch,
  type LegEstimate,
  type PublicNotice,
  type PublicSpot,
  type PublicStatus,
  pathLengthM,
  type ScheduleRow,
  type ServiceDef,
  type ServiceExceptionDef,
} from "@eci-shuttle/shared";
import { and, eq, gt, gte, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "@/db";
import {
  departureMatches,
  legStats,
  pings,
  routes,
  serviceExceptions,
  services,
  serviceVehicles,
  spots,
  vehicleState,
  vehicles,
  workspaces,
} from "@/db/schema";
import type { LegStat, Notice, Route, Service, Spot, VehicleState } from "@/db/types";
import { ServiceError } from "../kernel";
import { activeNotices } from "../notices/notices";

const STALE_MS = 2 * 60_000;
const MATCH_WINDOW_MS = 25 * 60_000;
const MIN_SAMPLES = 5;
const BASELINE_MPS = 25 / 3.6;
const BASELINE_DWELL_S = 180;
const DAY = 86_400_000;

const addDays = (date: string, n: number) => istDate(istToEpoch(date, "00:00") + n * DAY);
const weekday = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const iso = (ms: number) => new Date(ms).toISOString();

type Est = { medianS: number; p20S: number; p80S: number; n: number };
const asEstimate = ({ medianS, p20S, p80S, n }: Est, level: LegEstimate["level"]): LegEstimate => ({
  medianS,
  p20S,
  p80S,
  n,
  level,
  thin: level === "baseline" || n < MIN_SAMPLES,
});
const flat = (s: number): LegEstimate => asEstimate({ medianS: s, p20S: s, p80S: s, n: 0 }, "baseline");

/** One public service running at a service day, with everything needed to answer for its spots. */
type Running = {
  svc: Service;
  route: Route;
  day: string;
  windowStart: number;
  windowEnd: number;
  legs: EtaLeg[];
  dwells: Record<string, LegEstimate>;
  /** departure-from-spot offset (ms) from the route's first spot, by spot index */
  offsetMs: number[];
  departures: number[];
};

/**
 * The whole public status of a workspace at `now`. Spots = those on a public service running today, in route
 * order. Per spot, one AnswerLine per public service serving it:
 * - live: a vehicle on that service with a ping ≤ 2 min old → etaToSpot minutes, p20–p80 range, approx when
 *   basis is "estimate", phaseText ("leaving Circle now", "at Riva", "on the way"), lastSeenS.
 * - timetable: no live data → next planned departure from that spot today (learned typical time for the
 *   slot when known), phaseText "live tracking off".
 * - none: nothing more today ("no more shuttles today").
 * Notices: everywhere / spot / service / schedule placements active at now (notices.activeNotices), pinned first
 * by sort, then urgent first, then newest. Schedule rows: today's departures from the spot, past/next flags;
 * loop services as "about every N min" from the measured cycle.
 */
export async function publicStatus(db: Db, workspaceId: string, now: Date): Promise<PublicStatus> {
  const nowMs = now.getTime();
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw new ServiceError("NOT_FOUND", "Workspace not found.");

  const svcs = await db
    .select()
    .from(services)
    .where(and(eq(services.workspaceId, workspaceId), eq(services.public, true), isNull(services.archivedAt)));
  const today = istDate(nowMs);
  const yesterday = addDays(today, -1);
  const exRows = svcs.length
    ? await db
        .select()
        .from(serviceExceptions)
        .where(
          and(
            inArray(
              serviceExceptions.serviceId,
              svcs.map((s) => s.id),
            ),
            inArray(serviceExceptions.date, [yesterday, today]),
          ),
        )
    : [];
  const exceptions: ServiceExceptionDef[] = exRows.map((e) => ({
    serviceId: e.serviceId,
    date: e.date,
    type: e.kind,
    departure: e.departure,
    minutes: e.minutes,
  }));

  // service days in play: today, plus yesterday's for a cross-midnight service still inside its window
  const days: { svc: Service; day: string; windowStart: number; windowEnd: number }[] = [];
  for (const svc of svcs) {
    for (const day of [yesterday, today]) {
      const windowStart = istToEpoch(day, svc.startTime);
      const windowEnd = istToEpoch(svc.endTime < svc.startTime ? addDays(day, 1) : day, svc.endTime);
      const runs =
        day >= svc.validFrom &&
        day <= svc.validTo &&
        svc.daysOfWeek.includes(weekday(day)) &&
        !exceptions.some((e) => e.serviceId === svc.id && e.date === day && e.type === "cancel_day");
      if (runs && (day === today || nowMs < windowEnd)) days.push({ svc, day, windowStart, windowEnd });
    }
  }
  days.sort((a, b) => a.windowStart - b.windowStart);

  const routeRows = days.length
    ? await db
        .select()
        .from(routes)
        .where(
          inArray(
            routes.id,
            days.map((d) => d.svc.routeId),
          ),
        )
    : [];
  const routeById = new Map(routeRows.map((r) => [r.id, r]));
  const allSpotIds = [...new Set(routeRows.flatMap((r) => r.spotIds))];
  const spotRows = allSpotIds.length
    ? await db
        .select()
        .from(spots)
        .where(and(inArray(spots.id, allSpotIds), isNull(spots.archivedAt)))
    : [];
  const spotById = new Map(spotRows.map((s) => [s.id, s]));
  const stats = allSpotIds.length ? await db.select().from(legStats).where(eq(legStats.workspaceId, workspaceId)) : [];
  const hour = Number(istHHMM(nowMs).slice(0, 2));

  const running: Running[] = [];
  for (const d of days) {
    const route = routeById.get(d.svc.routeId);
    if (!route || route.spotIds.length === 0) continue;
    const pick = (kind: "leg" | "dwell", from: string, to: string | null, h: number | null): LegStat | undefined => {
      const scope = d.svc.kind === "special" ? d.svc.id : null;
      return stats.find(
        (s) =>
          s.kind === kind &&
          s.fromSpotId === from &&
          s.toSpotId === to &&
          s.serviceId === scope &&
          s.hourBucket === h &&
          s.n >= (h === null ? 1 : MIN_SAMPLES),
      );
    };
    const learned = (s: LegStat | undefined, level: LegEstimate["level"]) => s && asEstimate(s, level);
    const ids = route.spotIds;
    const pIdx = route.spotPathIdx;
    const legs: EtaLeg[] = [];
    for (let i = 0; i < ids.length - 1; i++) {
      const from = ids[i] as string;
      const to = ids[i + 1] as string;
      const lengthM = pIdx.length === ids.length ? pathLengthM(route.path.slice(pIdx[i], (pIdx[i + 1] ?? 0) + 1)) : 0;
      const typical = route.typicalLegS[i];
      const estimate =
        learned(pick("leg", from, to, hour), "leg_hour") ??
        learned(pick("leg", from, to, null), "leg_day") ??
        (typical ? asEstimate({ medianS: typical, p20S: typical, p80S: typical, n: MIN_SAMPLES }, "leg_day") : null) ??
        flat(Math.round(lengthM / BASELINE_MPS));
      legs.push({ fromSpotId: from, toSpotId: to, lengthM, estimate });
    }
    const dwells: Record<string, LegEstimate> = {};
    for (const id of ids)
      dwells[id] ??=
        learned(pick("dwell", id, null, hour), "leg_hour") ??
        learned(pick("dwell", id, null, null), "leg_day") ??
        flat(BASELINE_DWELL_S);
    // departing spot k = legs before it + the dwells at every spot after the first, up to and including k
    const offsetMs = [0];
    for (let k = 1; k < ids.length; k++)
      offsetMs[k] =
        (offsetMs[k - 1] as number) +
        ((legs[k - 1]?.estimate.medianS ?? 0) + (dwells[ids[k] as string]?.medianS ?? 0)) * 1000;
    const def: ServiceDef = {
      id: d.svc.id,
      kind: d.svc.kind,
      routeId: d.svc.routeId,
      public: d.svc.public,
      validFrom: d.svc.validFrom,
      validTo: d.svc.validTo,
      daysOfWeek: d.svc.daysOfWeek,
      startTime: d.svc.startTime,
      endTime: d.svc.endTime,
      pattern: d.svc.pattern,
    };
    const departures = expandServiceDepartures(def, exceptions, d.day).map((x) => x.at);
    running.push({ ...d, route, legs, dwells, offsetMs, departures });
  }

  // toggle order: spots as they come along the running routes
  const spotOrder: Spot[] = [];
  for (const r of running)
    for (const id of departIds(r.route)) {
      const s = spotById.get(id);
      if (s && !spotOrder.includes(s)) spotOrder.push(s);
    }

  const live = await liveVehicles(db, workspaceId, running, nowMs);
  const typical = await typicalDelays(db, workspaceId, nowMs);
  const notices = await activeNotices(db, workspaceId, now);
  const placed = (p: string) => notices.filter((n) => n.placements.includes(p as Notice["placements"][number]));

  const out: PublicSpot[] = spotOrder.map((spot) => {
    const serving = running.filter((r) => departIds(r.route).includes(spot.id));
    const rows: ScheduleRow[] = [];
    const loops: PublicSpot["schedule"]["loops"] = [];
    const answers: AnswerLine[] = [];
    // one line per service, even when yesterday's and today's service days both run
    for (const svcId of [...new Set(serving.map((r) => r.svc.id))]) {
      const rs = serving.filter((r) => r.svc.id === svcId);
      const first = rs[0] as Running;
      const k = first.route.spotIds.indexOf(spot.id);
      const times = rs.flatMap((r) => r.departures.map((at) => at + (r.offsetMs[k] ?? 0))).sort((a, b) => a - b);
      for (const at of times)
        rows.push({
          serviceId: svcId,
          serviceName: first.svc.name,
          at: iso(at),
          label: istHHMM(at),
          past: at < nowMs,
          next: false,
        });
      const everyMin = first.svc.pattern.kind === "loop" ? cycleMin(first, live.assigned.get(svcId) ?? 1) : null;
      if (everyMin) loops.push({ serviceId: svcId, serviceName: first.svc.name, everyMin });
      answers.push(
        answerFor(
          spot,
          first,
          rs,
          times,
          everyMin,
          live.byService.get(svcId) ?? [],
          typical,
          placed(`service:${svcId}`),
          nowMs,
          spotById,
        ),
      );
    }
    rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const nextRow = rows.find((r) => !r.past);
    if (nextRow) nextRow.next = true;
    return {
      spotId: spot.id,
      name: spot.name,
      shortName: spot.shortName,
      notices: placed(`spot:${spot.id}`).map(publicNotice),
      answers,
      schedule: { notices: placed("schedule").map(publicNotice), rows, loops },
    };
  });

  return {
    workspace: { slug: ws.slug, name: ws.name, isLive: ws.isLive },
    generatedAt: iso(nowMs),
    notices: placed("everywhere").map(publicNotice),
    spots: out,
  };
}

/** The answer lines for one spot (bot /shuttle, arrival alerts). Same rules as publicStatus. */
export async function spotAnswer(db: Db, workspaceId: string, spotId: string, now: Date): Promise<AnswerLine[]> {
  const s = await publicStatus(db, workspaceId, now);
  return s.spots.find((x) => x.spotId === spotId)?.answers ?? [];
}

/** Spots a shuttle departs from: every spot but a one-way route's terminus (a loop's last spot is its first). */
const departIds = (r: Route) => (r.spotIds.length > 1 ? r.spotIds.slice(0, -1) : r.spotIds);

const publicNotice = (n: Notice): PublicNotice => ({
  id: n.id,
  text: n.text,
  severity: n.severity,
  pinned: n.pinned,
  endsAt: n.endsAt ? iso(n.endsAt.getTime()) : null,
});

/** "about every N min": one full lap (legs + dwells at each departure spot) shared by the vehicles on it. */
function cycleMin(r: Running, vehicleCount: number): number {
  const lapS =
    r.legs.reduce((s, l) => s + l.estimate.medianS, 0) +
    departIds(r.route).reduce((s, id) => s + (r.dwells[id]?.medianS ?? 0), 0);
  return Math.max(1, Math.round(lapS / 60 / Math.max(1, vehicleCount)));
}

type Live = { vehicle: { id: string; name: string }; state: VehicleState; stopped: boolean };

async function liveVehicles(db: Db, workspaceId: string, running: Running[], nowMs: number) {
  const byService = new Map<string, Live[]>();
  const assigned = new Map<string, number>();
  const ids = running.map((r) => r.svc.id);
  if (!ids.length) return { byService, assigned };
  const now = new Date(nowMs);
  const rows = await db
    .select({ serviceId: serviceVehicles.serviceId, vehicle: vehicles, state: vehicleState })
    .from(serviceVehicles)
    .innerJoin(vehicles, eq(vehicles.id, serviceVehicles.vehicleId))
    .leftJoin(vehicleState, eq(vehicleState.vehicleId, vehicles.id))
    .where(
      and(
        eq(serviceVehicles.workspaceId, workspaceId),
        inArray(serviceVehicles.serviceId, ids),
        lte(serviceVehicles.startsAt, now),
        gt(serviceVehicles.endsAt, now),
        eq(vehicles.active, true),
      ),
    );
  for (const r of rows) {
    const s = r.state;
    // a vehicle answers only for the service ingest resolved it to (SPEC §3: a party run drops out of the line)
    if (s?.serviceId && s.serviceId !== r.serviceId) continue;
    assigned.set(r.serviceId, (assigned.get(r.serviceId) ?? 0) + 1);
    const fresh = s?.lastPingAt && nowMs - s.lastPingAt.getTime() <= STALE_MS;
    if (!s || !fresh || s.serviceId !== r.serviceId || (s.phase !== "at_spot" && s.phase !== "en_route")) continue;
    const list = byService.get(r.serviceId) ?? [];
    list.push({
      vehicle: r.vehicle,
      state: s,
      stopped: s.phase === "en_route" && (await isStopped(db, s.vehicleId, nowMs)),
    });
    byService.set(r.serviceId, list);
  }
  return { byService, assigned };
}

/** En route but not moving: ≥ 3 pings in the last 3 min, spanning ≥ 2 min, all at walking pace or less. */
async function isStopped(db: Db, vehicleId: string, nowMs: number): Promise<boolean> {
  const recent = await db
    .select({ at: pings.recordedAt, speed: pings.speed })
    .from(pings)
    .where(and(eq(pings.vehicleId, vehicleId), gte(pings.recordedAt, new Date(nowMs - 3 * 60_000))));
  if (recent.length < 3) return false;
  const t = recent.map((p) => p.at.getTime());
  return Math.max(...t) - Math.min(...t) >= 2 * 60_000 && recent.every((p) => p.speed !== null && p.speed <= 0.5);
}

/** Median delay per (service, spot, planned IST HH:MM) over the last 7 days, when there are ≥ 3 departures. */
async function typicalDelays(db: Db, workspaceId: string, nowMs: number): Promise<Map<string, number>> {
  const rows = await db
    .select({
      serviceId: departureMatches.serviceId,
      spotId: departureMatches.spotId,
      plannedAt: departureMatches.plannedAt,
      delayMin: departureMatches.delayMin,
    })
    .from(departureMatches)
    .where(
      and(
        eq(departureMatches.workspaceId, workspaceId),
        eq(departureMatches.missed, false),
        gte(departureMatches.plannedAt, new Date(nowMs - 7 * DAY)),
        lte(departureMatches.date, addDays(istDate(nowMs), -1)),
      ),
    );
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    if (r.delayMin === null) continue;
    const key = `${r.serviceId}|${r.spotId}|${istHHMM(r.plannedAt.getTime())}`;
    groups.set(key, [...(groups.get(key) ?? []), r.delayMin]);
  }
  const out = new Map<string, number>();
  for (const [key, xs] of groups) {
    if (xs.length < 3) continue;
    xs.sort((a, b) => a - b);
    out.set(key, Math.round(xs[Math.floor(xs.length / 2)] as number));
  }
  return out;
}

function answerFor(
  spot: Spot,
  r: Running,
  rs: Running[],
  times: number[],
  everyMin: number | null,
  live: Live[],
  typical: Map<string, number>,
  serviceNotices: Notice[],
  nowMs: number,
  spotById: Map<string, Spot>,
): AnswerLine {
  const base: AnswerLine = {
    serviceId: r.svc.id,
    serviceName: r.svc.name,
    colour: r.svc.colour,
    kind: "none",
    minutes: null,
    rangeLo: null,
    rangeHi: null,
    approx: false,
    nextAt: null,
    nextAtLabel: null,
    phaseText: "no more shuttles today",
    lastSeenS: null,
    vehicleName: null,
    notices: serviceNotices.map(publicNotice),
  };

  // a timed service only answers live for a departure that still exists today (a loop runs all window)
  const runLeft = (arriveMs: number) =>
    r.svc.pattern.kind === "loop" || (times.length > 0 && arriveMs <= (times.at(-1) as number) + MATCH_WINDOW_MS);
  // live: soonest vehicle with an ETA; an off-route one only when nobody else is live
  let best: { line: AnswerLine; minutes: number } | null = null;
  let offRoute: AnswerLine | null = null;
  for (const v of live) {
    const s = v.state;
    const line: AnswerLine = {
      ...base,
      kind: "live",
      lastSeenS: Math.max(0, Math.round((nowMs - (s.lastPingAt as Date).getTime()) / 1000)),
      vehicleName: v.vehicle.name,
      phaseText: "on the way",
    };
    if (s.offRoute) {
      offRoute ??= { ...line, phaseText: "off the usual route" };
      continue;
    }
    if (s.phase === "at_spot" && s.spotId === spot.id) {
      if (!runLeft(nowMs)) continue;
      const here = { ...line, minutes: 0, rangeLo: 0, rangeHi: 0, phaseText: "here now" };
      if (!best || best.minutes > 0) best = { line: here, minutes: 0 };
      continue;
    }
    const vehicle = etaVehicle(r, s);
    const eta =
      vehicle &&
      etaToSpot({
        legs: r.legs,
        dwells: r.dwells,
        vehicle,
        targetSpotId: spot.id,
        loop: r.svc.pattern.kind === "loop" || r.route.spotIds[0] === r.route.spotIds.at(-1),
        now: nowMs,
      });
    if (!eta || !runLeft(nowMs + eta.seconds * 1000)) continue;
    const at = s.spotId ? spotById.get(s.spotId)?.shortName : undefined;
    const phaseText = v.stopped
      ? "stopped on the way"
      : s.phase === "at_spot" && at
        ? `at ${at}`
        : at && nowMs - s.since.getTime() < 60_000
          ? `leaving ${at} now`
          : "on the way";
    if (!best || eta.minutes < best.minutes)
      best = {
        minutes: eta.minutes,
        line: {
          ...line,
          minutes: eta.minutes,
          rangeLo: eta.lo,
          rangeHi: eta.hi,
          approx: eta.basis === "estimate",
          phaseText,
        },
      };
  }
  if (best) return best.line;
  if (offRoute) return offRoute;

  // timetable
  if (everyMin) {
    const start = Math.min(...rs.map((x) => x.windowStart));
    const end = Math.max(...rs.map((x) => x.windowEnd));
    if (nowMs < start)
      return {
        ...base,
        kind: "timetable",
        nextAt: iso(start),
        nextAtLabel: istHHMM(start),
        phaseText: "first shuttle today",
      };
    if (nowMs < end)
      return { ...base, kind: "timetable", phaseText: `about every ${everyMin} min · live tracking off` };
    return base;
  }
  // pick on the learned typical time: a 10:00 that usually leaves 10:04 is still next at 10:02.
  // Never earlier than planned: a typically-early departure must not make people turn up late for it.
  const shifted = (t: number) => t + Math.max(0, typical.get(`${r.svc.id}|${spot.id}|${istHHMM(t)}`) ?? 0) * 60_000;
  const next = times.find((t) => shifted(t) >= nowMs);
  if (next === undefined) return base;
  const nextAt = shifted(next);
  return {
    ...base,
    kind: "timetable",
    nextAt: iso(nextAt),
    nextAtLabel: istHHMM(nextAt),
    phaseText: times[0] === next ? "first shuttle today" : "live tracking off",
  };
}

/** Where the vehicle is on this service's route, for etaToSpot. */
function etaVehicle(r: Running, s: VehicleState): EtaVehicle | null {
  const ids = r.route.spotIds;
  if (s.phase === "at_spot") {
    const k = s.spotId ? ids.indexOf(s.spotId) : -1;
    return k < 0 ? null : { kind: "at_spot", spotIndex: k, since: s.since.getTime() };
  }
  const i = s.nextSpotId ? ids.indexOf(s.nextSpotId, 1) - 1 : -1;
  if (i < 0) return null;
  const pIdx = r.route.spotPathIdx;
  const legStartM = pIdx.length === ids.length ? pathLengthM(r.route.path.slice(0, (pIdx[i] ?? 0) + 1)) : 0;
  return { kind: "en_route", legIndex: i, alongLegM: Math.max(0, (s.alongM ?? 0) - legStartM) };
}
