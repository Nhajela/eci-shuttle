/** admin-activity (SPEC §7): the audit log as day-grouped cards, filterable by entity, day, actor, object, proposal. */
import { istHHMM } from "@eci-shuttle/shared";
import { XIcon } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AuditRow } from "@/db/types";
import { type ActivityPage, describeAudit } from "@/services/activity/activity";
import { type ActivityFilters, activityHref, diffEntries, ENTITIES, groupByDay } from "./activity";

const chip = "inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm underline-offset-4 hover:underline";

export function ActivityView({
  page,
  filters,
  paged,
}: {
  page: ActivityPage;
  filters: ActivityFilters;
  /** this is an older page (a `before` cursor is set) */
  paged: boolean;
}) {
  const days = groupByDay(page.rows);
  const narrowing: { label: string; clear: ActivityFilters }[] = [];
  if (filters.entityId) narrowing.push({ label: "One object", clear: { entityId: undefined } });
  if (filters.actor) narrowing.push({ label: "One person or phone", clear: { actor: undefined } });
  if (filters.proposal) narrowing.push({ label: "One MCP proposal", clear: { proposal: undefined } });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Activity</h1>

      <form
        action="/admin/activity"
        method="get"
        className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        {filters.w && <input type="hidden" name="w" value={filters.w} />}
        {filters.actor && <input type="hidden" name="actor" value={filters.actor} />}
        {filters.proposal && <input type="hidden" name="proposal" value={filters.proposal} />}
        {/* on an object timeline the entity is locked; the "One object" chip is the way out */}
        {filters.entityId && <input type="hidden" name="entityId" value={filters.entityId} />}
        {filters.entityId && filters.entity && <input type="hidden" name="entity" value={filters.entity} />}
        <div className="grid gap-1.5">
          <Label htmlFor="activity-entity">What</Label>
          <select
            id="activity-entity"
            name="entity"
            defaultValue={filters.entity ?? ""}
            disabled={!!filters.entityId}
            className="h-11 w-full rounded-(--radius-field) border border-input bg-background px-3 text-base"
          >
            <option value="">Everything</option>
            {ENTITIES.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
            {filters.entity && !ENTITIES.some((e) => e.value === filters.entity) && (
              <option value={filters.entity}>{filters.entity}</option>
            )}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="activity-since">Since (IST day)</Label>
          <Input id="activity-since" type="date" name="since" defaultValue={filters.since ?? ""} />
        </div>
        <button type="submit" className={buttonVariants({ className: "h-11" })}>
          Show
        </button>
      </form>

      {narrowing.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {narrowing.map((n) => (
            <Link
              key={n.label}
              href={activityHref(filters, n.clear)}
              className={buttonVariants({ variant: "secondary", className: "min-h-11" })}
            >
              {n.label}
              <XIcon aria-label="clear" />
            </Link>
          ))}
        </div>
      )}

      {days.length === 0 && (
        <p className="py-8 text-center text-muted-foreground">
          {paged ? "No older changes." : "Nothing changed yet with these filters."}
        </p>
      )}

      {days.map((d) => (
        <section key={d.day} className="flex flex-col gap-2">
          <h2 className="sticky top-14 z-10 bg-background py-1 text-sm font-semibold text-muted-foreground">
            {d.label}
          </h2>
          {d.rows.map((r) => (
            <ActivityCard key={r.id} row={r} line={describeAudit(r)} filters={filters} />
          ))}
        </section>
      ))}

      <nav className="flex justify-between gap-2">
        {paged ? (
          <Link href={activityHref(filters, {})} className={buttonVariants({ variant: "outline", className: "h-11" })}>
            Newest
          </Link>
        ) : (
          <span />
        )}
        {page.nextBefore && (
          <Link
            href={activityHref(filters, { before: page.nextBefore })}
            className={buttonVariants({ variant: "outline", className: "h-11" })}
          >
            Older
          </Link>
        )}
      </nav>
    </main>
  );
}

function ActivityCard({ row, line, filters }: { row: AuditRow; line: string; filters: ActivityFilters }) {
  const changes = diffEntries(row);
  return (
    <Card size="sm" className="gap-1 px-3">
      <p className="flex gap-3">
        <time dateTime={row.at.toISOString()} className="shrink-0 tabular-nums text-muted-foreground">
          {istHHMM(row.at)}
        </time>
        <span className="min-w-0 break-words">{line}</span>
      </p>
      {row.reason && <p className="break-words pl-14 text-sm text-muted-foreground">“{row.reason}”</p>}
      <div className="-mx-3 flex flex-wrap pl-11">
        {row.entityId && !filters.entityId && (
          <Link href={activityHref(filters, { entity: row.entity, entityId: row.entityId })} className={chip}>
            Timeline
          </Link>
        )}
        {!filters.actor && (
          <Link href={activityHref(filters, { actor: row.actorId })} className={chip}>
            By {row.actorLabel ?? "them"}
          </Link>
        )}
        {row.proposalId && !filters.proposal && (
          <Link href={activityHref(filters, { proposal: row.proposalId })} className={chip}>
            Same proposal
          </Link>
        )}
      </div>
      {changes.length > 0 && (
        <details className="pl-14 text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground">
            {changes.length} field{changes.length === 1 ? "" : "s"}
          </summary>
          <dl className="grid gap-1 pb-2">
            {changes.map((c) => (
              <div key={c.field} className="min-w-0">
                <dt className="font-medium">{c.field}</dt>
                <dd className="break-all text-muted-foreground">
                  {c.before !== null && <s>{c.before}</s>}
                  {c.before !== null && c.after !== null && " → "}
                  {c.after !== null && <span className="text-foreground">{c.after}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </Card>
  );
}
