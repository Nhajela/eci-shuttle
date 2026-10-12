"use client";
import { useActionState } from "react";
import { type ActionState, startSimAction, stopSimAction } from "@/app/admin/workspaces/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export type SimRow = { id: string; label: string; lastSync: string | null };

function Status({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <div role="status" className="flex flex-col gap-2">
      <p className={state.ok ? "text-sm" : "text-destructive text-sm"}>{state.message}</p>
      {state.command && (
        <>
          <p className="text-muted-foreground text-sm">Run this from the repo:</p>
          <code className="block rounded-md bg-muted p-3 font-mono text-sm break-all select-all">{state.command}</code>
        </>
      )}
    </div>
  );
}

function StopSim({ w, sim }: { w: string; sim: SimRow }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(stopSimAction, null);
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <form action={action} className="flex items-center justify-between gap-3">
        <input type="hidden" name="w" value={w} />
        <input type="hidden" name="deviceId" value={sim.id} />
        <div className="min-w-0">
          <p className="truncate font-medium">{sim.label}</p>
          <p className="text-muted-foreground text-sm">
            {sim.lastSync ? `Last sync ${sim.lastSync}` : "Not synced yet"}
          </p>
        </div>
        <Button type="submit" variant="destructive" disabled={pending} className="h-11 shrink-0">
          {pending ? "Stopping…" : "Stop"}
        </Button>
      </form>
      <Status state={state} />
    </li>
  );
}

/** Start a simulated phone (pairing code + command) and stop running ones. Test workspaces only. */
export function SimPanel({ w, vehicles, sims }: { w: string; vehicles: string[]; sims: SimRow[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(startSimAction, null);
  return (
    <div className="flex flex-col gap-4">
      {vehicles.length === 0 ? (
        <p className="text-muted-foreground text-sm">Add a vehicle first: the sim drives one.</p>
      ) : (
        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="w" value={w} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sim-vehicle">Vehicle</Label>
            <select
              id="sim-vehicle"
              name="vehicle"
              required
              className="h-11 rounded-md border border-input bg-background px-3 text-base"
            >
              {vehicles.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={pending} className="h-11">
            {pending ? "Starting…" : "Start simulated phone"}
          </Button>
          <Status state={state} />
        </form>
      )}
      {sims.length > 0 && (
        <ul className="flex flex-col gap-2">
          {sims.map((s) => (
            <StopSim key={s.id} w={w} sim={s} />
          ))}
        </ul>
      )}
    </div>
  );
}
