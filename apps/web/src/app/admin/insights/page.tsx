import { formatIst, istDate } from "@eci-shuttle/shared";
import type { Metadata } from "next";
import { ExcludeDayForm } from "@/components/admin/insights/exclude-day-form";
import { InsightsView } from "@/components/admin/insights/insights-view";
import { SuggestionCard } from "@/components/admin/insights/suggestion-card";
import { deadZoneLines, insightsRange } from "@/components/admin/insights/view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { listRoutes } from "@/services/catalog/routes";
import { listSpots } from "@/services/catalog/spots";
import { can } from "@/services/kernel";
import { getInsights, listSuggestions } from "@/services/learning/insights";
import { loadDeadZones } from "@/services/signal/dead-zones";

/** admin-insights (SPEC §6a.5–6, §7): on-time %, delay heatmap, dwell, leg times, loop, average wait, suggestions. */
export const metadata: Metadata = { title: "Insights" };

type Params = Record<string, string | string[] | undefined>;

export default async function InsightsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { actor, workspace } = await requireAdmin({ w: typeof sp.w === "string" ? sp.w : null });
  const now = new Date();
  const range = insightsRange(sp, now);
  const ws = { workspaceId: workspace.id };

  const [data, suggestions, spots, routes, deadZones] = await Promise.all([
    getInsights(db(), actor, { ...ws, ...range }),
    listSuggestions(db(), actor, { ...ws, status: "open" }),
    listSpots(db(), actor, { ...ws, includeArchived: true }),
    listRoutes(db(), actor, ws),
    loadDeadZones(db(), workspace.id),
  ]);
  const canDecide = can(actor, workspace.id, "ops");

  return (
    <main className="mx-auto max-w-5xl space-y-5 p-4 pb-24">
      <h1 className="text-xl font-semibold">Insights</h1>

      <form className="flex flex-wrap items-end gap-3" action="/admin/insights">
        <input type="hidden" name="w" value={workspace.slug} />
        <div className="grid gap-1">
          <Label htmlFor="from">From</Label>
          <Input id="from" name="from" type="date" defaultValue={range.from} className="h-11" />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="to">To</Label>
          <Input id="to" name="to" type="date" defaultValue={range.to} className="h-11" />
        </div>
        <Button type="submit" variant="outline" className="h-11 px-5">
          Show
        </Button>
      </form>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Timetable suggestions</h2>
        {suggestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open suggestions. The nightly job adds them at 02:30.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {suggestions.map((s) => (
              <SuggestionCard
                key={s.id}
                id={s.id}
                summary={s.summary}
                meta={`Suggested ${formatIst(s.createdAt)}`}
                w={workspace.slug}
                canDecide={canDecide}
              />
            ))}
          </div>
        )}
      </section>

      {deadZones.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Stretches without signal</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {deadZoneLines(deadZones, new Map(spots.map((s) => [s.id, s.name]))).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      {canDecide && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Skip a day</h2>
          <p className="text-sm text-muted-foreground">
            A road closure or festival made the times odd? Leave that day out of the learned times.
          </p>
          <ExcludeDayForm w={workspace.slug} today={istDate(now)} />
        </section>
      )}

      <InsightsView
        data={data}
        spots={new Map(spots.map((s) => [s.id, s.name]))}
        routes={new Map(routes.map((r) => [r.id, r.name]))}
      />
    </main>
  );
}
