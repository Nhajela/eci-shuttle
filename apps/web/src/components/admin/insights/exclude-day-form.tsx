"use client";
/** admin-insights: "Don't learn from this day" (SPEC §6a), e.g. a road closure skewed the times. ops+. */
import { useActionState } from "react";
import { excludeDayAction } from "@/app/admin/insights/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ExcludeDayForm(props: { w: string; today: string }) {
  const [state, action, pending] = useActionState(excludeDayAction, null);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-end">
      <input type="hidden" name="w" value={props.w} />
      <div className="grid gap-1">
        <Label htmlFor="exclude-date">Day</Label>
        <Input id="exclude-date" name="date" type="date" required defaultValue={props.today} className="h-11" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="exclude-reason">Reason (optional)</Label>
        <Input id="exclude-reason" name="reason" maxLength={500} placeholder="Road closed" className="h-11" />
      </div>
      <Button type="submit" variant="outline" className="h-11 px-5" disabled={pending}>
        {pending ? "Saving…" : "Don't learn from this day"}
      </Button>
      {state && (
        <p role={state.ok ? "status" : "alert"} className={state.ok ? "text-sm" : "text-sm text-destructive"}>
          {state.ok ? `${state.date} won't be used for learned times or suggestions.` : state.error}
        </p>
      )}
    </form>
  );
}
