"use client";
import { setLegNoSignalAction } from "@/app/admin/routes/actions";
import { Button } from "@/components/ui/button";
import { useActionToast } from "./useActionToast";

type Mode = "auto" | "no_signal" | "has_signal";

const OPTIONS: { mode: Mode; label: string }[] = [
  { mode: "auto", label: "Auto" },
  { mode: "no_signal", label: "No signal" },
  { mode: "has_signal", label: "Has signal" },
];

/**
 * Per-leg signal control (admin only), three states: Auto (the system decides from late phone uploads), No signal
 * (the public map shows an estimated, faded shuttle on this leg) and Has signal (ignore a wrongly detected stretch).
 * One form, three submit buttons; tap targets are 44px and the row wraps on a phone.
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
  state: "manual" | "detected" | "cleared" | null;
}) {
  const [formAction, pending] = useActionToast(setLegNoSignalAction);
  const current: Mode = state === "manual" ? "no_signal" : state === "cleared" ? "has_signal" : "auto";
  const hint =
    state === "manual"
      ? "Marked by you: no signal"
      : state === "cleared"
        ? "Marked by you: has signal, detection is ignored here"
        : state === "detected"
          ? "Auto: no signal found from late phone uploads"
          : "Auto: signal looks fine";
  return (
    <form action={formAction} className="flex flex-col gap-1 py-1">
      <input type="hidden" name="w" value={w} />
      <input type="hidden" name="routeId" value={routeId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="legIndex" value={legIndex} />
      <span className="text-sm">
        Signal on this stretch
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <fieldset className="m-0 grid grid-cols-3 gap-2 border-0 p-0" aria-label="Signal on this stretch">
        {OPTIONS.map((o) => (
          <Button
            key={o.mode}
            type="submit"
            name="mode"
            value={o.mode}
            variant={o.mode === current ? "secondary" : "outline"}
            aria-pressed={o.mode === current}
            className="h-11 px-2"
            disabled={pending || o.mode === current}
          >
            {o.label}
          </Button>
        ))}
      </fieldset>
    </form>
  );
}
