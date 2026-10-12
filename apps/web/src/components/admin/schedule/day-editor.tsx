"use client";
import type { ExceptionKind } from "@eci-shuttle/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionForm, type FormAction, field } from "./action-form";

const KINDS: { value: ExceptionKind; label: string }[] = [
  { value: "cancel_departure", label: "Cancel a departure" },
  { value: "shift_minutes", label: "Move a departure" },
  { value: "add_departure", label: "Add a departure" },
  { value: "cancel_day", label: "Cancel the whole day" },
];

/** One-day edit of a service: cancel, move or add a departure, or cancel the day. The pattern stays as it is. */
export function DayEditor({
  w,
  serviceId,
  date,
  planned,
  action,
}: {
  w: string;
  serviceId: string;
  date: string;
  /** the pattern times of this day's departures (what cancel / move name) */
  planned: string[];
  action: FormAction;
}) {
  const [kind, setKind] = useState<ExceptionKind>(planned.length ? "cancel_departure" : "add_departure");
  const usable = planned.length ? KINDS : KINDS.filter((k) => k.value === "add_departure" || k.value === "cancel_day");
  return (
    <ActionForm action={action} success="Day updated">
      <input type="hidden" name="w" value={w} />
      <input type="hidden" name="serviceId" value={serviceId} />
      <input type="hidden" name="date" value={date} />
      <label className="flex flex-col gap-1 text-sm">
        Change for this day only
        <select name="type" value={kind} onChange={(e) => setKind(e.target.value as ExceptionKind)} className={field}>
          {usable.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      {(kind === "cancel_departure" || kind === "shift_minutes") && (
        <label className="flex flex-col gap-1 text-sm">
          Departure
          <select name="departure" required className={field}>
            {planned.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === "add_departure" && (
        <label className="flex flex-col gap-1 text-sm">
          New departure (IST)
          <input type="time" name="departure" required className={field} />
        </label>
      )}
      {kind === "shift_minutes" && (
        <label className="flex flex-col gap-1 text-sm">
          Move by minutes (negative = earlier)
          <input type="number" name="minutes" required min={-180} max={180} defaultValue={10} className={field} />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Note (optional)
        <input name="note" className={field} placeholder="Road closed near Riva" />
      </label>
      <Button type="submit" size="lg" variant={kind === "cancel_day" ? "destructive" : "default"}>
        {KINDS.find((k) => k.value === kind)?.label}
      </Button>
    </ActionForm>
  );
}
