"use client";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Vehicle } from "@/db/types";

export type VehicleFormState = { ok: boolean; message: string | null };

type Props = {
  /** workspace slug, so the server action acts in the workspace this page shows */
  w: string;
  action: (prev: VehicleFormState, form: FormData) => Promise<VehicleFormState>;
  /** absent = create */
  vehicle?: Pick<Vehicle, "id" | "version" | "name" | "plate" | "colour" | "capacity" | "active">;
};

/** One-column vehicle form with a sticky Save. Create when `vehicle` is absent. */
export function VehicleForm({ w, action, vehicle }: Props) {
  const [state, submit, pending] = useActionState(action, { ok: true, message: null });
  const id = vehicle?.id ?? "new";
  const [noColour, setNoColour] = useState(!!vehicle && !vehicle.colour);
  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="w" value={w} />
      {vehicle && (
        <>
          <input type="hidden" name="vehicleId" value={vehicle.id} />
          <input type="hidden" name="version" value={vehicle.version} />
        </>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor={`name-${id}`}>Name</Label>
        <Input id={`name-${id}`} name="name" required maxLength={100} defaultValue={vehicle?.name} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`plate-${id}`}>Number plate</Label>
        <Input id={`plate-${id}`} name="plate" maxLength={20} defaultValue={vehicle?.plate ?? ""} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`capacity-${id}`}>Seats</Label>
        <Input
          id={`capacity-${id}`}
          name="capacity"
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          defaultValue={vehicle?.capacity ?? ""}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`colour-${id}`}>Colour (what attendees see)</Label>
        <div className="flex items-center gap-4">
          <input
            id={`colour-${id}`}
            name="colour"
            type="color"
            defaultValue={vehicle?.colour ?? "#1f6feb"}
            // picking a colour means the admin wants one: untick "No colour" so it is saved
            onChange={() => setNoColour(false)}
            className={`h-11 w-16 cursor-pointer rounded-(--radius-field) border border-input bg-background ${noColour ? "opacity-40 grayscale" : ""}`}
          />
          <Label className="min-h-11">
            <input
              type="checkbox"
              name="noColour"
              checked={noColour}
              onChange={(e) => setNoColour(e.target.checked)}
              className="size-5"
            />
            No colour
          </Label>
        </div>
      </div>
      <Label className="min-h-11">
        <input type="checkbox" name="active" defaultChecked={vehicle?.active ?? true} className="size-5" />
        Active (inactive vehicles stop tracking)
      </Label>
      <div className="sticky bottom-0 -mx-1 flex items-center gap-3 bg-card px-1 py-2">
        <Button type="submit" disabled={pending} className="h-11 flex-1">
          {pending ? "Saving…" : vehicle ? "Save" : "Add vehicle"}
        </Button>
      </div>
      {state.message && (
        <p role="status" className={state.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
          {state.message}
        </p>
      )}
    </form>
  );
}
