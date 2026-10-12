import { istDate, ROLE_RANK } from "@eci-shuttle/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, field } from "@/components/admin/schedule/action-form";
import { DayEditor } from "@/components/admin/schedule/day-editor";
import {
  addDays,
  dayLabel,
  departureLabel,
  describeException,
  describePattern,
  formatRange,
  weekDays,
  weekStart,
} from "@/components/admin/schedule/schedule";
import { ServiceForm } from "@/components/admin/schedule/service-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import type { Service } from "@/db/types";
import { requireAdmin } from "@/lib/session";
import { listRoutes } from "@/services/catalog/routes";
import { getSchedule } from "@/services/catalog/schedule";
import { listVehicles } from "@/services/catalog/vehicles";
import {
  addExceptionAction,
  assignVehicleAction,
  duplicateServiceAction,
  removeExceptionAction,
  saveServiceAction,
  unassignVehicleAction,
} from "./actions";

/** admin-schedule (SPEC §7): week view, services, one-day exceptions, vehicle staffing, duplicate as special. */
export const metadata: Metadata = { title: "Schedule" };

const WEEKDAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { actor, workspace, role } = await requireAdmin({ w: one(sp.w) ?? null });
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.ops;
  const today = istDate(Date.now());
  const d = one(sp.d);
  const day = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today;
  const start = weekStart(day);
  const w = workspace.slug;
  const href = (date: string) => `/admin/schedule?${new URLSearchParams({ w, d: date })}`;

  const [week, routes, vehicles] = await Promise.all([
    getSchedule(db(), actor, { workspaceId: workspace.id, from: start, days: 7 }),
    listRoutes(db(), actor, { workspaceId: workspace.id }),
    listVehicles(db(), actor, { workspaceId: workspace.id }),
  ]);
  const routeName = new Map(routes.map((r) => [r.id, r.name]));
  const vehicleName = new Map(vehicles.map((v) => [v.id, v.name]));
  const services = [...new Map(week.flatMap((x) => x.services.map((s) => [s.service.id, s.service]))).values()];
  const selected = week.find((x) => x.date === day)?.services ?? [];
  const routeOptions = routes.filter((r) => !r.archivedAt).map((r) => ({ id: r.id, name: r.name }));

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 pb-24">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Schedule</h1>
        <span className="text-sm text-muted-foreground">Times in IST</span>
      </div>

      <nav aria-label="Week" className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="lg"
          render={<Link href={href(addDays(start, -7))} />}
          aria-label="Previous week"
        >
          ‹
        </Button>
        <span className="text-sm font-medium">
          {dayLabel(start)} – {dayLabel(addDays(start, 6))}
        </span>
        <Button variant="outline" size="lg" render={<Link href={href(addDays(start, 7))} />} aria-label="Next week">
          ›
        </Button>
      </nav>

      <div className="grid grid-cols-7 gap-1">
        {weekDays(start).map((date) => {
          const count = week.find((x) => x.date === date)?.services.length ?? 0;
          const [wd, dd] = dayLabel(date).split(" ");
          return (
            <Link
              key={date}
              href={href(date)}
              aria-current={date === day ? "date" : undefined}
              className={`flex min-h-14 flex-col items-center justify-center rounded-lg border text-xs ${
                date === day ? "border-primary bg-primary text-primary-foreground" : ""
              } ${date === today && date !== day ? "border-primary" : ""}`}
            >
              <span>{wd}</span>
              <span className="text-base font-semibold">{dd}</span>
              <span aria-hidden>{count ? "•".repeat(Math.min(count, 4)) : " "}</span>
              <span className="sr-only">{count} services</span>
            </Link>
          );
        })}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">
          {dayLabel(day)}
          {day === today ? " (today)" : ""}
        </h2>
        {selected.length === 0 && <p className="text-sm text-muted-foreground">No services run this day.</p>}
        {selected.map(({ service, exceptions, vehicles: staffed, departures }) => {
          const dayCancelled = exceptions.some((e) => e.kind === "cancel_day");
          return (
            <Card key={service.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {service.colour && (
                    <span aria-hidden className="size-3 rounded-full" style={{ background: service.colour }} />
                  )}
                  {service.name}
                  <Badge variant={service.kind === "special" ? "default" : "secondary"}>{service.kind}</Badge>
                  {!service.public && <Badge variant="outline">hidden</Badge>}
                  {dayCancelled && <Badge variant="destructive">cancelled</Badge>}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  {service.startTime}–{service.endTime} · {describePattern(service.pattern)} ·{" "}
                  {routeName.get(service.routeId) ?? "unknown route"}
                </p>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div>
                  <h3 className="mb-1 text-sm font-medium">Departures</h3>
                  {departures.length ? (
                    <ul className="flex flex-wrap gap-1.5 text-sm">
                      {departures.map((x) => (
                        <li key={`${x.planned}-${x.at}`} className="rounded-md bg-muted px-2 py-1 tabular-nums">
                          {departureLabel(x)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {dayCancelled ? "None: the day is cancelled." : "No fixed times."}
                    </p>
                  )}
                </div>

                {exceptions.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Changes for this day</h3>
                    <ul className="flex flex-col gap-1.5">
                      {exceptions.map((e) => (
                        <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
                          <span>
                            {describeException(e)}
                            {e.note && <span className="text-muted-foreground"> · {e.note}</span>}
                          </span>
                          {canEdit && (
                            <ActionForm action={removeExceptionAction} success="Change undone">
                              <input type="hidden" name="w" value={w} />
                              <input type="hidden" name="exceptionId" value={e.id} />
                              <Button type="submit" variant="outline" size="lg">
                                Undo
                              </Button>
                            </ActionForm>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <h3 className="mb-1 text-sm font-medium">Vehicles</h3>
                  {staffed.length === 0 && <p className="text-sm text-muted-foreground">No vehicle assigned.</p>}
                  <ul className="flex flex-col gap-1.5">
                    {staffed.map((sv) => (
                      <li key={sv.id} className="flex items-center justify-between gap-2 text-sm">
                        <span>
                          <span className="font-medium">{vehicleName.get(sv.vehicleId) ?? "Vehicle"}</span>{" "}
                          {formatRange(sv.startsAt, sv.endsAt)}
                        </span>
                        {canEdit && (
                          <ActionForm action={unassignVehicleAction} success="Vehicle removed">
                            <input type="hidden" name="w" value={w} />
                            <input type="hidden" name="serviceVehicleId" value={sv.id} />
                            <Button type="submit" variant="outline" size="lg">
                              Remove
                            </Button>
                          </ActionForm>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                {canEdit && (
                  <>
                    <details className="rounded-lg border p-3">
                      <summary className="min-h-11 cursor-pointer content-center font-medium">Assign a vehicle</summary>
                      <ActionForm action={assignVehicleAction} success="Vehicle assigned" className="mt-2">
                        <input type="hidden" name="w" value={w} />
                        <input type="hidden" name="serviceId" value={service.id} />
                        <input type="hidden" name="date" value={day} />
                        <label className="flex flex-col gap-1 text-sm">
                          Vehicle
                          <select name="vehicleId" required className={field}>
                            {vehicles
                              .filter((v) => v.active)
                              .map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="flex flex-col gap-1 text-sm">
                            From
                            <input
                              type="time"
                              name="start"
                              required
                              defaultValue={service.startTime}
                              className={field}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-sm">
                            To
                            <input type="time" name="end" required defaultValue={service.endTime} className={field} />
                          </label>
                        </div>
                        <Button type="submit" size="lg">
                          Assign
                        </Button>
                      </ActionForm>
                    </details>
                    <details className="rounded-lg border p-3">
                      <summary className="min-h-11 cursor-pointer content-center font-medium">Edit this day</summary>
                      <div className="mt-2">
                        <DayEditor
                          w={w}
                          serviceId={service.id}
                          date={day}
                          planned={departures.filter((x) => !x.added).map((x) => x.planned)}
                          action={addExceptionAction}
                        />
                      </div>
                    </details>
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Services this week</h2>
        {services.length === 0 && <p className="text-sm text-muted-foreground">No services this week.</p>}
        {services.map((s) => (
          <ServiceCard key={s.id} s={s} w={w} day={day} canEdit={canEdit} routes={routeOptions} />
        ))}
        {canEdit && (
          <details className="rounded-lg border p-3">
            <summary className="min-h-11 cursor-pointer content-center font-medium">New service</summary>
            <div className="mt-2">
              {routeOptions.length ? (
                <ServiceForm w={w} routes={routeOptions} defaultDate={day} action={saveServiceAction} />
              ) : (
                <p className="text-sm text-muted-foreground">Add a route first (Routes page).</p>
              )}
            </div>
          </details>
        )}
      </section>
    </main>
  );
}

function ServiceCard({
  s,
  w,
  day,
  canEdit,
  routes,
}: {
  s: Service;
  w: string;
  day: string;
  canEdit: boolean;
  routes: { id: string; name: string }[];
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {s.name}
          <Badge variant={s.kind === "special" ? "default" : "secondary"}>{s.kind}</Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {s.daysOfWeek.map((n) => WEEKDAY[n]).join(" ")} · {s.startTime}–{s.endTime} · {describePattern(s.pattern)} ·{" "}
          {dayLabel(s.validFrom)} to {dayLabel(s.validTo)}
        </p>
      </CardHeader>
      {canEdit && (
        <CardContent className="flex flex-col gap-2">
          <details className="rounded-lg border p-3">
            <summary className="min-h-11 cursor-pointer content-center font-medium">Edit service</summary>
            <div className="mt-2">
              <ServiceForm
                w={w}
                routes={routes}
                defaultDate={day}
                action={saveServiceAction}
                service={{
                  id: s.id,
                  version: s.version,
                  name: s.name,
                  kind: s.kind,
                  routeId: s.routeId,
                  public: s.public,
                  colour: s.colour,
                  validFrom: s.validFrom,
                  validTo: s.validTo,
                  daysOfWeek: s.daysOfWeek,
                  startTime: s.startTime,
                  endTime: s.endTime,
                  pattern: s.pattern,
                }}
              />
            </div>
          </details>
          <details className="rounded-lg border p-3">
            <summary className="min-h-11 cursor-pointer content-center font-medium">Duplicate as special</summary>
            <ActionForm action={duplicateServiceAction} success="Special service created" className="mt-2">
              <input type="hidden" name="w" value={w} />
              <input type="hidden" name="serviceId" value={s.id} />
              <p className="text-sm text-muted-foreground">
                A copy for a one-off (like a party run), with no vehicles yet.
              </p>
              <label className="flex flex-col gap-1 text-sm">
                Name
                <input name="name" required defaultValue={`${s.name} (special)`} className={field} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-sm">
                  From
                  <input type="date" name="validFrom" required defaultValue={day} className={field} />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  To
                  <input type="date" name="validTo" required defaultValue={day} className={field} />
                </label>
              </div>
              <Button type="submit" size="lg">
                Duplicate
              </Button>
            </ActionForm>
          </details>
        </CardContent>
      )}
    </Card>
  );
}
