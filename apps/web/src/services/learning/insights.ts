/** learning: admin Insights and MCP shuttle_insights / shuttle_suggestions (SPEC §6a.5–6). viewer+ reads. */
import { IST_TZ, IsoDate, notImplemented } from "@eci-shuttle/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import type { LearningExclusion, Suggestion } from "@/db/types";
import { type Actor, parseInput, readable } from "../kernel";

export type Insights = {
  /** % of departures within 3 min, per spot */
  onTime: { spotId: string; pct: number; n: number }[];
  /** heatmap: departure slot "HH:MM" × IST weekday → average and p80 delay */
  delayBySlot: { spotId: string; slot: string; weekday: number; avgMin: number; p80Min: number; n: number }[];
  dwellBySpotHour: { spotId: string; hour: number; medianS: number; n: number }[];
  legByHour: { fromSpotId: string; toSpotId: string; hour: number; medianS: number; n: number }[];
  loopCycleS: { routeId: string; medianS: number; n: number }[];
  /** % of service windows that had live tracking */
  trackedPct: number;
  /** E[H²]/2E[H] per spot, seconds */
  averageWaitS: { spotId: string; seconds: number | null }[];
};

export async function getInsights(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; from: IsoDate; to: IsoDate },
  now: Date = new Date(),
): Promise<Insights> {
  const { workspaceId: w, from, to } = parseInput(InsightsInput, input);
  readable(actor, w);
  const rows = <T>(q: SQL) => db.execute(q) as unknown as Promise<T[]>;
  /** the IST day of a timestamptz column is inside [from, to] */
  const inRange = (col: string) =>
    sql`(${sql.raw(col)} at time zone ${IST_TZ})::date between ${from}::date and ${to}::date`;
  const istHour = (col: string) => sql`extract(hour from ${sql.raw(col)} at time zone ${IST_TZ})::int`;

  const [onTime, delayBySlot, dwellBySpotHour, legByHour, loopCycleS, averageWaitS, tracked] = await Promise.all([
    // missed departures count against on-time (abs(null) <= 3 is not true)
    rows<Insights["onTime"][number]>(sql`
      select spot_id as "spotId", count(*)::int as n,
        (100.0 * count(*) filter (where not missed and abs(delay_min) <= 3) / count(*))::float8 as pct
      from departure_matches
      where workspace_id = ${w} and date between ${from}::date and ${to}::date
      group by spot_id order by spot_id`),
    // weekday of the service day, so a 01:00 run of a Saturday-night service stays on Saturday
    rows<Insights["delayBySlot"][number]>(sql`
      select spot_id as "spotId", to_char(planned_at at time zone ${IST_TZ}, 'HH24:MI') as slot,
        extract(isodow from date)::int as weekday, avg(delay_min)::float8 as "avgMin",
        percentile_cont(0.8) within group (order by delay_min)::float8 as "p80Min", count(*)::int as n
      from departure_matches
      where workspace_id = ${w} and date between ${from}::date and ${to}::date and not missed and delay_min is not null
      group by 1, 2, 3 order by 1, 2, 3`),
    rows<Insights["dwellBySpotHour"][number]>(sql`
      select spot_id as "spotId", ${istHour("arrived_at")} as hour, count(*)::int as n,
        percentile_cont(0.5) within group (order by extract(epoch from departed_at - arrived_at))::float8 as "medianS"
      from dwells
      where workspace_id = ${w} and departed_at is not null and ${inRange("arrived_at")}
      group by 1, 2 order by 1, 2`),
    // same filter as the learned stats: only finished, clean trips
    rows<Insights["legByHour"][number]>(sql`
      select from_spot_id as "fromSpotId", to_spot_id as "toSpotId", ${istHour("departed_at")} as hour,
        percentile_cont(0.5) within group (
          order by coalesce(duration_s, extract(epoch from arrived_at - departed_at))
        )::float8 as "medianS", count(*)::int as n
      from trips
      where workspace_id = ${w} and quality = 'clean' and arrived_at is not null and to_spot_id is not null
        and ${inRange("departed_at")}
      group by 1, 2, 3 order by 1, 2, 3`),
    // a loop = one vehicle's consecutive departures from the route's first spot on the same IST day
    rows<Insights["loopCycleS"][number]>(sql`
      with c as (
        select t.route_id, extract(epoch from t.departed_at - lag(t.departed_at) over (
          partition by t.vehicle_id, t.route_id, (t.departed_at at time zone ${IST_TZ})::date order by t.departed_at
        )) as s
        from trips t join routes r on r.id = t.route_id
        where t.workspace_id = ${w} and t.from_spot_id = r.spot_ids[1] and ${inRange("t.departed_at")}
      )
      select route_id as "routeId", percentile_cont(0.5) within group (order by s)::float8 as "medianS", count(*)::int as n
      from c where s is not null group by 1 order by 1`),
    // E[H²] / 2E[H] over headways between departures (any vehicle) from the spot, within one service run on one
    // IST day: the gap between a morning and an evening service is not a wait.
    // same maths as shared averageWait(), done in SQL so headways never leave the database.
    rows<Insights["averageWaitS"][number]>(sql`
      with h as (
        select from_spot_id as spot_id, extract(epoch from departed_at - lag(departed_at) over (
          partition by from_spot_id, service_id, (departed_at at time zone ${IST_TZ})::date order by departed_at
        )) as h
        from trips where workspace_id = ${w} and ${inRange("departed_at")}
      )
      select sp.id as "spotId", (sum(h.h * h.h) / (2 * sum(h.h)))::float8 as seconds
      from spots sp left join h on h.spot_id = sp.id and h.h > 0
      where sp.workspace_id = ${w} and sp.archived_at is null
      group by sp.id order by sp.id`),
    // a service window = one assigned vehicle × one IST day the service runs, start..end (cross-midnight aware),
    // clipped to the assignment. Tracked = at least one ping from that vehicle inside it. Windows not yet started
    // by now are left out, so a range running into the future does not read as untracked.
    rows<{ total: number; tracked: number }>(sql`
      with days as (select d::date as d from generate_series(${from}::date, ${to}::date, interval '1 day') d),
      win as (
        select sv.vehicle_id, greatest(sv.starts_at, x.ws) as s, least(sv.ends_at, x.we) as e
        from service_vehicles sv
        join services s on s.id = sv.service_id
        cross join days
        cross join lateral (select
          (days.d + s.start_time::time) at time zone ${IST_TZ} as ws,
          (days.d + s.end_time::time
            + case when s.end_time <= s.start_time then interval '1 day' else interval '0' end) at time zone ${IST_TZ} as we
        ) x
        where sv.workspace_id = ${w} and s.archived_at is null
          and days.d between s.valid_from and s.valid_to
          and extract(isodow from days.d)::int = any(s.days_of_week)
          and not exists (select 1 from service_exceptions e
            where e.service_id = s.id and e.date = days.d and e.kind = 'cancel_day')
      )
      select count(*)::int as total, count(*) filter (where exists (
        select 1 from pings p where p.vehicle_id = win.vehicle_id and p.recorded_at >= win.s and p.recorded_at < win.e
      ))::int as tracked
      from win where s < least(e, ${now.toISOString()}::timestamptz)`),
  ]);

  const { total, tracked: hit } = tracked[0] ?? { total: 0, tracked: 0 };
  return {
    onTime,
    delayBySlot,
    dwellBySpotHour,
    legByHour,
    loopCycleS,
    trackedPct: total ? (100 * hit) / total : 0,
    averageWaitS,
  };
}

const InsightsInput = z
  .object({ workspaceId: z.uuid(), from: IsoDate, to: IsoDate })
  .refine((i) => i.from <= i.to, { message: "from must be on or before to", path: ["to"] });

/** viewer+. Open first. */
export async function listSuggestions(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; status?: Suggestion["status"] },
): Promise<Suggestion[]> {
  return notImplemented(db, actor, input);
}

/**
 * ops+. Accepting turns the suggestion's proposedChanges into a normal MCP proposal (mcp/proposals.propose) and
 * stores its id; the timetable only changes when someone confirms it. Audited suggestion.accept.
 */
export async function acceptSuggestion(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; suggestionId: string },
): Promise<{ suggestion: Suggestion; proposalCode: string; summary: string }> {
  return notImplemented(db, actor, input);
}

/** ops+. Audited suggestion.dismiss. */
export async function dismissSuggestion(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; suggestionId: string },
): Promise<Suggestion> {
  return notImplemented(db, actor, input);
}

export const ExcludeDayInput = z.object({
  workspaceId: z.uuid(),
  date: z.iso.date(),
  serviceId: z.uuid().nullable().default(null),
  reason: z.string().max(500).nullable().default(null),
});
/** ops+. "Don't learn from this day" (road closure). Audited learning.exclude. */
export async function excludeDay(
  db: Db,
  actor: Actor,
  input: z.input<typeof ExcludeDayInput>,
): Promise<LearningExclusion> {
  return notImplemented(db, actor, input);
}
