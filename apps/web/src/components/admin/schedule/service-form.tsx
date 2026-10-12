"use client";
import type { ServicePattern } from "@eci-shuttle/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionForm, type FormAction, field } from "./action-form";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type ServiceFormValues = {
  id: string;
  version: number;
  name: string;
  kind: "regular" | "special";
  routeId: string;
  public: boolean;
  colour: string | null;
  validFrom: string;
  validTo: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  pattern: ServicePattern;
};

/** Create (no `service`) or edit a service. One column, sticky Save. */
export function ServiceForm({
  w,
  routes,
  service,
  defaultDate,
  action,
}: {
  w: string;
  routes: { id: string; name: string }[];
  service?: ServiceFormValues;
  defaultDate: string;
  action: FormAction;
}) {
  const [patternKind, setPatternKind] = useState(service?.pattern.kind ?? "every");
  const p = service?.pattern;
  return (
    <ActionForm action={action} success={service ? "Service saved" : "Service created"}>
      <input type="hidden" name="w" value={w} />
      {service && <input type="hidden" name="serviceId" value={service.id} />}
      {service && <input type="hidden" name="version" value={service.version} />}
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input name="name" required defaultValue={service?.name} className={field} placeholder="Riva ↔ Circle" />
      </label>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1">Kind</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["regular", "special"] as const).map((k) => (
            <label key={k} className="flex h-11 items-center gap-2 rounded-lg border px-3 capitalize">
              <input type="radio" name="kind" value={k} defaultChecked={(service?.kind ?? "regular") === k} />
              {k}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">
        Route
        <select name="routeId" required defaultValue={service?.routeId ?? routes[0]?.id} className={field}>
          {routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex h-11 items-center gap-2 text-sm">
        <input type="checkbox" name="public" defaultChecked={service?.public ?? true} className="size-5" />
        Shown on the public page
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Colour (optional)
        <input name="colour" defaultValue={service?.colour ?? ""} className={field} placeholder="#2563eb" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-sm">
          From
          <input
            type="date"
            name="validFrom"
            required
            defaultValue={service?.validFrom ?? defaultDate}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          To
          <input type="date" name="validTo" required defaultValue={service?.validTo ?? defaultDate} className={field} />
        </label>
      </div>
      <fieldset className="text-sm">
        <legend className="mb-1">Days</legend>
        <div className="grid grid-cols-7 gap-1">
          {WEEKDAYS.map((d, i) => (
            <label key={d} className="flex h-11 flex-col items-center justify-center rounded-lg border text-xs">
              <input
                type="checkbox"
                name="days"
                value={i + 1}
                defaultChecked={service ? service.daysOfWeek.includes(i + 1) : true}
              />
              {d}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-sm">
          Starts (IST)
          <input type="time" name="startTime" required defaultValue={service?.startTime ?? "08:00"} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Ends (IST)
          <input type="time" name="endTime" required defaultValue={service?.endTime ?? "22:00"} className={field} />
        </label>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">An end before the start runs past midnight.</p>
      <label className="flex flex-col gap-1 text-sm">
        Departures
        <select
          name="patternKind"
          value={patternKind}
          onChange={(e) => setPatternKind(e.target.value as ServicePattern["kind"])}
          className={field}
        >
          <option value="every">Every N minutes</option>
          <option value="times">Exact times</option>
          <option value="loop">Continuous loop (no fixed times)</option>
        </select>
      </label>
      {patternKind === "every" && (
        <label className="flex flex-col gap-1 text-sm">
          Every (minutes)
          <input
            type="number"
            name="everyMin"
            min={5}
            max={240}
            required
            defaultValue={p?.kind === "every" ? p.everyMin : 20}
            className={field}
          />
        </label>
      )}
      {patternKind === "times" && (
        <label className="flex flex-col gap-1 text-sm">
          Times (IST, separated by commas or spaces)
          <textarea
            name="times"
            required
            rows={3}
            defaultValue={p?.kind === "times" ? p.times.join(", ") : ""}
            className={`${field} h-auto py-2`}
            placeholder="22:00, 23:00, 00:30, 02:00"
          />
        </label>
      )}
      <div className="sticky bottom-0 -mx-1 bg-background px-1 py-2">
        <Button type="submit" size="lg" className="w-full">
          {service ? "Save service" : "Create service"}
        </Button>
      </div>
    </ActionForm>
  );
}
