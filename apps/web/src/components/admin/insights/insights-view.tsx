/** admin-insights: the read-only stats (server component). Cards, not tables; heatmap fits 390px. */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Insights } from "@/services/learning/insights";
import { fmtDelay, fmtDuration, heatmap, heatTone } from "./view";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TONE = {
  ok: "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200",
  warn: "bg-amber-500/25 text-amber-950 dark:text-amber-100",
  bad: "bg-red-500/30 text-red-950 dark:text-red-100",
};
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

function Section(props: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        {props.hint && <CardDescription>{props.hint}</CardDescription>}
      </CardHeader>
      <CardContent>{props.children}</CardContent>
    </Card>
  );
}

function Rows(props: { rows: { key: string; label: string; value: string; sub?: string }[] }) {
  if (!props.rows.length) return <p className="text-sm text-muted-foreground">No data in this range yet.</p>;
  return (
    <ul className="divide-y">
      {props.rows.map((r) => (
        <li key={r.key} className="flex items-baseline justify-between gap-3 py-2 text-sm">
          <span className="min-w-0 break-words">{r.label}</span>
          <span className="shrink-0 text-right tabular-nums">
            <span className="font-medium">{r.value}</span>
            {r.sub && <span className="ml-1 text-muted-foreground">{r.sub}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function InsightsView({
  data,
  spots,
  routes,
}: {
  data: Insights;
  spots: Map<string, string>;
  routes: Map<string, string>;
}) {
  const spot = (id: string) => spots.get(id) ?? "Unknown spot";
  const heatSpots = [...new Set(data.delayBySlot.map((r) => r.spotId))];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Section
        title="On time"
        hint={`Departures within 3 min · ${data.trackedPct.toFixed(0)}% of service windows tracked`}
      >
        <Rows
          rows={data.onTime.map((r) => ({
            key: r.spotId,
            label: spot(r.spotId),
            value: `${r.pct.toFixed(0)}%`,
            sub: `n=${r.n}`,
          }))}
        />
      </Section>

      <Section
        title="Average wait"
        hint="For someone who turns up at a random time, from the real gaps between shuttles"
      >
        <Rows
          rows={data.averageWaitS.map((r) => ({ key: r.spotId, label: spot(r.spotId), value: fmtDuration(r.seconds) }))}
        />
      </Section>

      <div className="md:col-span-2">
        <Section title="Delay by departure" hint="Average delay per timetable slot and IST weekday; p80 in each cell">
          {heatSpots.length === 0 && (
            <p className="text-sm text-muted-foreground">No matched departures in this range yet.</p>
          )}
          <div className="space-y-5">
            {heatSpots.map((id) => (
              <div key={id}>
                <h3 className="mb-1 text-sm font-medium">From {spot(id)}</h3>
                <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))] gap-0.5 text-center text-[11px] tabular-nums">
                  <span />
                  {DAYS.map((d) => (
                    <span key={d} className="text-muted-foreground">
                      {d}
                    </span>
                  ))}
                  {heatmap(data.delayBySlot, id).map((row) => [
                    <span key={row.slot} className="self-center text-left font-medium">
                      {row.slot}
                    </span>,
                    ...row.days.map((c, i) =>
                      c ? (
                        <span
                          key={`${row.slot}-${DAYS[i]}`}
                          className={`rounded py-1 ${TONE[heatTone(c.avgMin)]}`}
                          title={`${DAYS[i]} ${row.slot}: avg ${fmtDelay(c.avgMin)}, p80 ${fmtDelay(c.p80Min)}, n=${c.n}`}
                        >
                          {Math.round(c.avgMin)}
                          <span className="block opacity-70">{Math.round(c.p80Min)}</span>
                        </span>
                      ) : (
                        <span key={`${row.slot}-${DAYS[i]}`} className="rounded bg-muted/40" />
                      ),
                    ),
                  ])}
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <Section title="Dwell" hint="Median time standing at a spot, by IST hour">
        <Rows
          rows={data.dwellBySpotHour.map((r) => ({
            key: `${r.spotId}-${r.hour}`,
            label: `${spot(r.spotId)} · ${hh(r.hour)}`,
            value: fmtDuration(r.medianS),
            sub: `n=${r.n}`,
          }))}
        />
      </Section>

      <Section title="Leg time" hint="Median spot-to-spot time, by IST hour">
        <Rows
          rows={data.legByHour.map((r) => ({
            key: `${r.fromSpotId}-${r.toSpotId}-${r.hour}`,
            label: `${spot(r.fromSpotId)} → ${spot(r.toSpotId)} · ${hh(r.hour)}`,
            value: fmtDuration(r.medianS),
            sub: `n=${r.n}`,
          }))}
        />
      </Section>

      <Section title="Full loop" hint="Median time for one whole cycle of a route">
        <Rows
          rows={data.loopCycleS.map((r) => ({
            key: r.routeId,
            label: routes.get(r.routeId) ?? "Unknown route",
            value: fmtDuration(r.medianS),
            sub: `n=${r.n}`,
          }))}
        />
      </Section>
    </div>
  );
}
