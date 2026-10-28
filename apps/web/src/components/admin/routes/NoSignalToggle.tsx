"use client";
import { setLegNoSignalAction } from "@/app/admin/routes/actions";
import { Button } from "@/components/ui/button";
import { useActionToast } from "./useActionToast";

/**
 * Per-leg "No signal on this stretch" control (admin only). Marking tells the public map to show an estimated,
 * faded shuttle on this leg instead of "can't see it right now". `detected` = found automatically from phones that
 * uploaded late; marking it makes it permanent and covers the whole leg.
 */
export function NoSignalToggle({
  w,
  routeId,
  version,
  legIndex,
  state,
}: {
  w: string;
  routeId: string;
  version: number;
  legIndex: number;
  state: "manual" | "detected" | null;
}) {
  const [formAction, pending] = useActionToast(setLegNoSignalAction);
  const on = state === "manual";
  return (
    <form action={formAction} className="flex min-h-11 items-center justify-between gap-3">
      <input type="hidden" name="w" value={w} />
      <input type="hidden" name="routeId" value={routeId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="legIndex" value={legIndex} />
      <input type="hidden" name="noSignal" value={on ? "0" : "1"} />
      <span className="min-w-0 text-sm">
        No signal on this stretch
        <span className="block text-xs text-muted-foreground">
          {on ? "Marked by you" : state === "detected" ? "Found automatically from late phone uploads" : "Not marked"}
        </span>
      </span>
      <Button type="submit" variant={on ? "secondary" : "outline"} className="h-11 shrink-0" disabled={pending}>
        {on ? "Turn off" : "Mark"}
      </Button>
    </form>
  );
}
