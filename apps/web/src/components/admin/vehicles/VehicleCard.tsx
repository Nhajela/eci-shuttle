import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Vehicle } from "@/db/types";
import { VehicleForm } from "./VehicleForm";
import { tripLine } from "./view";

type Props = {
  vehicle: Vehicle;
  phoneLabel: string | null;
  service: { name: string; until: string } | null;
  trips: (Parameters<typeof tripLine>[0] & { id: string })[];
  w: string;
  /** null = read-only (viewer) */
  action: ComponentProps<typeof VehicleForm>["action"] | null;
};

const SHOWN_TRIPS = 20;

/** One vehicle: what attendees see, its phone and service now, recent trips, and (ops+) the edit form. */
export function VehicleCard({ vehicle: v, phoneLabel, service, trips, w, action }: Props) {
  const facts = [v.plate, v.capacity ? `${v.capacity} seats` : null].filter(Boolean).join(" · ");
  return (
    <Card size="sm" className={v.active ? undefined : "opacity-70"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            aria-hidden
            className="size-4 shrink-0 rounded-full ring-1 ring-foreground/15"
            style={{ background: v.colour ?? "transparent" }}
          />
          <span className="min-w-0 truncate">{v.name}</span>
          {!v.active && <Badge variant="secondary">Inactive</Badge>}
        </CardTitle>
        {facts && <p className="text-sm text-muted-foreground">{facts}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm">
        <p>
          <span className="text-muted-foreground">Phone: </span>
          {phoneLabel ?? (
            <a href={`/admin/phones?w=${encodeURIComponent(w)}`} className="underline underline-offset-4">
              none, assign one in Phones
            </a>
          )}
        </p>
        <p>
          <span className="text-muted-foreground">Now: </span>
          {service ? `${service.name}, until ${service.until}` : "not on a service"}
        </p>
        <details className="mt-2">
          <summary className="flex min-h-11 cursor-pointer items-center font-medium">
            Trips, last 7 days ({trips.length})
          </summary>
          {trips.length === 0 ? (
            <p className="text-muted-foreground">No trips yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {trips.slice(0, SHOWN_TRIPS).map((t) => (
                <li key={t.id} className="break-words">
                  {tripLine(t)}
                </li>
              ))}
              {trips.length > SHOWN_TRIPS && (
                <li className="text-muted-foreground">and {trips.length - SHOWN_TRIPS} older</li>
              )}
            </ul>
          )}
        </details>
        {action && (
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center font-medium">Edit</summary>
            <VehicleForm w={w} action={action} vehicle={v} />
          </details>
        )}
      </CardContent>
    </Card>
  );
}
