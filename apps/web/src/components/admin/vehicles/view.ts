/** admin-vehicles: pure view logic for the Vehicles page (no DB, no React). Times are IST. */
import { formatIst, type HHMM, istHHMM, type TripQuality } from "@eci-shuttle/shared";

/** The phone driving this vehicle now (revoked phones don't count). */
export function currentPhone<D extends { revokedAt: Date | null }>(
  phones: { device: D; vehicle: { id: string } | null }[],
  vehicleId: string,
): D | null {
  return phones.find((p) => p.vehicle?.id === vehicleId && !p.device.revokedAt)?.device ?? null;
}

/** The service the vehicle is staffing at `now` (from getSchedule days), and when that ends. */
export function currentService(
  days: {
    services: { service: { name: string }; vehicles: { vehicleId: string; startsAt: Date; endsAt: Date }[] }[];
  }[],
  vehicleId: string,
  now: number,
): { name: string; until: HHMM } | null {
  for (const { services } of days)
    for (const { service, vehicles } of services)
      for (const sv of vehicles)
        if (sv.vehicleId === vehicleId && +sv.startsAt <= now && now < +sv.endsAt)
          return { name: service.name, until: istHHMM(sv.endsAt) };
  return null;
}

const QUALITY: Record<TripQuality, string | null> = { clean: null, off_route: "off route", gap: "gap in tracking" };

/** "Mon 12 Oct, 09:40 · Riva → Circle · 25 min" */
export function tripLine(t: {
  departedAt: Date;
  arrivedAt: Date | null;
  durationS: number | null;
  fromName: string;
  toName: string | null;
  quality: TripQuality;
}): string {
  const parts = [formatIst(t.departedAt), `${t.fromName} → ${t.toName ?? "…"}`];
  parts.push(t.arrivedAt && t.durationS != null ? `${Math.round(t.durationS / 60)} min` : "on the way");
  const q = QUALITY[t.quality];
  if (q) parts.push(q);
  return parts.join(" · ");
}

/** Form → vehicle service input (create, or update when vehicleId is present). The service validates. */
export function vehicleFields(form: FormData): Record<string, unknown> {
  const text = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const capacity = text("capacity");
  const out: Record<string, unknown> = {
    name: text("name") ?? "",
    plate: text("plate"),
    colour: form.get("noColour") === "on" ? null : text("colour"),
    capacity: capacity === null ? null : Number(capacity),
    active: form.get("active") === "on",
  };
  const vehicleId = text("vehicleId");
  if (vehicleId) return { vehicleId, version: Number(text("version")), ...out };
  return out;
}
