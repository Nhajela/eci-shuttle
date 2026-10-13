"use client";
import type { PathSource } from "@eci-shuttle/shared";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useState } from "react";
import { createRouteAction, updateRouteAction } from "@/app/admin/routes/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { moveItem } from "./routes";
import { useActionToast } from "./useActionToast";

type SpotOption = { id: string; name: string };

const minutes = (s: number | undefined) => (s == null ? "" : s / 60);

/** Create a route, or edit one's name and ordered spots. A loop repeats the first spot at the end. */
export function RouteForm({
  w,
  spots,
  names,
  route,
  onDone,
}: {
  w: string;
  /** spots that can be added (non-archived) */
  spots: SpotOption[];
  /** every spot's name, archived ones included, for spots already on the route */
  names: Record<string, string>;
  route?: {
    id: string;
    version: number;
    name: string;
    spotIds: string[];
    pathSource?: PathSource;
    /** planned wait in seconds: "*" = every stop, a spot id = that stop */
    plannedDwellS?: Record<string, number>;
  };
  onDone?: () => void;
}) {
  const [order, setOrder] = useState<string[]>(route?.spotIds ?? []);
  const [pick, setPick] = useState(spots[0]?.id ?? "");
  const [formAction, pending] = useActionToast(route ? updateRouteAction : createRouteAction, () => {
    if (!route) setOrder([]);
    onDone?.();
  });

  // edits send the spots only when they changed, so a rename keeps the path (and works with archived spots on it)
  const spotsChanged = !route || order.join() !== route.spotIds.join();
  const plan = route?.plannedDwellS ?? {};
  const stops = [...new Set(order)];

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        if (
          route?.pathSource === "manual" &&
          spotsChanged &&
          !confirm("Changing the spots replaces the hand-adjusted path with a generated one. Continue?")
        )
          e.preventDefault();
      }}
    >
      <input type="hidden" name="w" value={w} />
      {route && <input type="hidden" name="routeId" value={route.id} />}
      {route && <input type="hidden" name="version" value={route.version} />}
      {spotsChanged &&
        order.map((id, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a loop repeats a spot id
          <input key={i} type="hidden" name="spotId" value={id} />
        ))}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`name-${route?.id ?? "new"}`}>Name</Label>
        <Input
          id={`name-${route?.id ?? "new"}`}
          name="name"
          required
          maxLength={100}
          defaultValue={route?.name}
          placeholder="Riva → Circle → Riva"
          className="h-11"
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">Spots, in driving order</legend>
        {order.length === 0 && <p className="text-sm text-muted-foreground">No spots yet. Add the first stop below.</p>}
        <ol className="flex flex-col gap-1.5">
          {order.map((id, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a loop repeats a spot id
            <li key={i} className="flex items-center gap-1 rounded-lg bg-muted/50 py-1 pr-1 pl-3">
              <span className="w-6 text-sm text-muted-foreground tabular-nums">{i + 1}.</span>
              <span className="min-w-0 flex-1 truncate">{names[id] ?? "Unknown spot"}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                aria-label="Move up"
                disabled={i === 0}
                onClick={() => setOrder(moveItem(order, i, -1))}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                aria-label="Move down"
                disabled={i === order.length - 1}
                onClick={() => setOrder(moveItem(order, i, 1))}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                aria-label="Remove"
                onClick={() => setOrder(order.filter((_, k) => k !== i))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ol>
        {spots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No spots in this workspace yet. Add them on the Spots page.</p>
        ) : (
          <div className="flex gap-2">
            <select
              aria-label="Spot to add"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3"
            >
              {spots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <Button type="button" variant="outline" className="h-11" onClick={() => pick && setOrder([...order, pick])}>
              Add
            </Button>
          </div>
        )}
        {order.length > 1 && order[0] !== order[order.length - 1] && (
          <Button
            type="button"
            variant="link"
            className="self-start px-0"
            onClick={() => setOrder([...order, order[0]])}
          >
            Back to {names[order[0]] ?? "the start"} (make it a loop)
          </Button>
        )}
      </fieldset>

      {route && (
        <fieldset className="flex flex-col gap-2">
          <Label htmlFor={`wait-${route.id}`}>Wait at each stop (min)</Label>
          <Input
            id={`wait-${route.id}`}
            name="waitMin"
            type="number"
            inputMode="decimal"
            min={0}
            max={60}
            step="any"
            defaultValue={minutes(plan["*"])}
            placeholder="Not set"
            className="h-11"
          />
          <p className="text-xs text-muted-foreground">
            Boarding time. Used for &ldquo;about every N min&rdquo; and arrival times until real waits are learned.
          </p>
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
              Different wait at a stop
            </summary>
            <div className="flex flex-col gap-1.5">
              {stops.map((id) => (
                <div key={id} className="flex items-center gap-2">
                  <Label htmlFor={`wait-${route.id}-${id}`} className="min-w-0 flex-1 truncate font-normal">
                    {names[id] ?? "Unknown spot"}
                  </Label>
                  <Input
                    id={`wait-${route.id}-${id}`}
                    name={`waitMin:${id}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={60}
                    step="any"
                    defaultValue={minutes(plan[id])}
                    placeholder="Same"
                    aria-label={`Wait at ${names[id] ?? "this stop"} (min)`}
                    className="h-11 w-24"
                  />
                </div>
              ))}
            </div>
          </details>
        </fieldset>
      )}

      <div className="sticky bottom-0 -mx-1 bg-card px-1 py-2">
        <Button type="submit" size="lg" className="w-full" disabled={pending || order.length < 2}>
          {pending ? "Saving…" : route ? "Save route" : "Create route"}
        </Button>
        {route && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Changing the spots regenerates the path from the road map.
          </p>
        )}
      </div>
    </form>
  );
}
