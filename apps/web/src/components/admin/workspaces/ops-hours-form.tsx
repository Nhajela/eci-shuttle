"use client";
import { useActionState } from "react";
import { type ActionState, opsHoursAction } from "@/app/admin/workspaces/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Ops tracking hours (IST, daily): phones in vehicles track all through them, off duty between services. */
export function OpsHoursForm({ w, start, end }: { w: string; start: string | null; end: string | null }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(opsHoursAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="w" value={w} />
      <p className="text-muted-foreground text-sm">
        Every day in these hours (IST), phones in vehicles share their location, also between services. Off duty, a
        vehicle shows only on the Live board, never to attendees.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="ops-start">From</Label>
          <Input id="ops-start" name="start" type="time" defaultValue={start ?? ""} className="h-11" />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="ops-end">Until</Label>
          <Input id="ops-end" name="end" type="time" defaultValue={end ?? ""} className="h-11" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Button type="submit" disabled={pending} className="h-11">
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="submit" name="off" value="1" variant="outline" disabled={pending || !start} className="h-11">
          Turn off
        </Button>
      </div>
      {state && (
        <p role="status" className={state.ok ? "text-sm" : "text-destructive text-sm"}>
          {state.message}
        </p>
      )}
    </form>
  );
}
