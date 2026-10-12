import { istDate } from "@eci-shuttle/shared";
import type { Metadata } from "next";
import { SHOWN_TRIPS, VehicleCard } from "@/components/admin/vehicles/VehicleCard";
import { VehicleForm } from "@/components/admin/vehicles/VehicleForm";
import { currentPhone, currentService } from "@/components/admin/vehicles/view";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { getSchedule } from "@/services/catalog/schedule";
import { listVehicles } from "@/services/catalog/vehicles";
import { listPhones } from "@/services/devices/phones";
import { can } from "@/services/kernel";
import { saveVehicle } from "./actions";
import { recentTrips } from "./trips";

/** admin-vehicles (SPEC §7): CRUD, current phone, current service, trip history. */
export const metadata: Metadata = { title: "Vehicles" };

const DAY_MS = 86_400_000;

export default async function VehiclesPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const { actor, workspace } = await requireAdmin({ w });
  const now = new Date();
  const d = db();
  const input = { workspaceId: workspace.id };
  const [vehicles, phones, days, trips] = await Promise.all([
    listVehicles(d, actor, input),
    listPhones(d, actor, input, now),
    // from yesterday: an assignment that started before midnight can still be running
    getSchedule(d, actor, { ...input, from: istDate(+now - DAY_MS), days: 2 }),
    recentTrips(d, actor, { ...input, since: new Date(+now - 7 * DAY_MS), perVehicle: SHOWN_TRIPS }),
  ]);
  const action = can(actor, workspace.id, "ops") ? saveVehicle : null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Vehicles</h1>
      {action && (
        <Card size="sm">
          <CardContent>
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center font-medium">Add a vehicle</summary>
              <VehicleForm w={workspace.slug} action={action} />
            </details>
          </CardContent>
        </Card>
      )}
      {vehicles.length === 0 ? (
        <p className="text-muted-foreground">No vehicles yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {vehicles.map((v) => (
            <VehicleCard
              key={v.id}
              vehicle={v}
              phoneLabel={currentPhone(phones, v.id)?.label ?? null}
              service={currentService(days, v.id, +now)}
              trips={trips.filter((t) => t.vehicleId === v.id)}
              w={workspace.slug}
              action={action}
            />
          ))}
        </div>
      )}
    </main>
  );
}
