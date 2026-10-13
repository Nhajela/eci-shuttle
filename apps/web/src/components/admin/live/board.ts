/** admin-live: pure view model for the Live board (SPEC §7). Built on the server from service reads; `now` in epoch ms. */
import { formatIst, type HHMM, type IsoDate, istDate, istHHMM, type Phase } from "@eci-shuttle/shared";
import type { Spot, Vehicle, VehicleBreak, VehicleState } from "@/db/types";
import type { Problem } from "@/services/alerts/watchdog";
import type { ScheduleDay } from "@/services/catalog/schedule";
import type { PhoneHealth } from "@/services/devices/phones";

export type BoardInput = {
  vehicles: Vehicle[];
  states: VehicleState[];
  phones: PhoneHealth[];
  problems: Problem[];
  /** vehicle id → its driver's break running now (catalog/breaks.activeBreaks) */
  breaks: Map<string, VehicleBreak>;
  /** yesterday and today, so last night's run past midnight is included */
  schedule: ScheduleDay[];
  spots: Spot[];
};

export type ProblemLine = { kind: Problem["kind"]; message: string };

export type VehicleCard = {
  vehicleId: string;
  name: string;
  colour: string | null;
  phase: Phase;
  /** "At Riva", "To Circle", "Offline", "Off duty" */
  phaseText: string;
  /** "6 min" / "now" when en route with an ETA */
  etaText: string | null;
  /** last GPS fix: "Location 3 min ago" / "No location yet" */
  locationText: string;
  /** last phone sync, which also happens without a fix: "Phone checked in 20s ago"; null with no phone */
  checkInText: string | null;
  batteryText: string | null;
  serviceName: string | null;
  deviceId: string | null;
  phoneLabel: string | null;
  /** every phone / Telegram / Traccar source on this vehicle, freshest fix first (deviceId above is the first) */
  sources: { deviceId: string; label: string; text: string; silent: boolean }[];
  /** IST HH:MM while a silence directive runs */
  silencedUntilText: string | null;
  problems: ProblemLine[];
  onBreak: boolean;
  /** "On break till 13:20" / "On break" (until ended by hand) */
  breakText: string | null;
  position: { lat: number; lng: number } | null;
};

export type NextDeparture = {
  serviceId: string;
  serviceName: string;
  /** the service day and pattern time: what a cancel_departure exception names */
  date: IsoDate;
  planned: HHMM;
  /** when it actually leaves (after shifts), IST */
  atText: HHMM;
};

export type Board = { cards: VehicleCard[]; otherProblems: ProblemLine[]; nextDepartures: NextDeparture[] };

export function agoText(t: Date | null, now: number): string {
  if (!t) return "never";
  const s = Math.max(0, Math.round((now - t.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return istDate(t) === istDate(now) ? `at ${istHHMM(t)}` : formatIst(t);
}

const line = (p: Problem): ProblemLine => ({ kind: p.kind, message: p.message });

const SOURCE: Record<string, string> = { telegram: "Telegram", traccar: "Traccar" };

export function buildBoard(input: BoardInput, now: number): Board {
  const spotName = new Map(input.spots.map((s) => [s.id, s.shortName]));
  const stateOf = new Map(input.states.map((s) => [s.vehicleId, s]));
  // several sources may back each other up on one vehicle: the freshest fix leads
  const fix = (p: PhoneHealth) => p.lastFixAt?.getTime() ?? p.device.lastSyncAt?.getTime() ?? 0;
  const phonesOf = new Map<string, PhoneHealth[]>();
  for (const p of input.phones) if (p.vehicle) phonesOf.set(p.vehicle.id, [...(phonesOf.get(p.vehicle.id) ?? []), p]);
  for (const list of phonesOf.values()) list.sort((a, b) => fix(b) - fix(a));
  const serviceName = new Map(input.schedule.flatMap((d) => d.services.map((s) => [s.service.id, s.service.name])));
  const used = new Set<Problem>();

  const cards = input.vehicles
    .filter((v) => v.active)
    .map((v): VehicleCard => {
      const st = stateOf.get(v.id);
      const all = phonesOf.get(v.id) ?? [];
      const ph = all[0];
      const dev = ph?.device;
      const phase: Phase = st?.phase ?? "off_duty";
      const problems = input.problems.filter(
        (p) => p.vehicleId === v.id || all.some((x) => x.device.id === p.deviceId),
      );
      for (const p of problems) used.add(p);
      const silence = ph?.activeDirectives.find(
        (d) => d.kind === "silence_until" && !d.cancelledAt && d.startsAt.getTime() <= now && d.endsAt.getTime() > now,
      );
      const brk = input.breaks.get(v.id);
      const brkEnd = brk && (brk.endedAt ?? brk.endsAt);
      return {
        vehicleId: v.id,
        name: v.name,
        colour: v.colour,
        phase,
        phaseText: phaseText(phase, st, spotName),
        etaText:
          phase === "en_route" && st?.etaS != null ? (st.etaS < 60 ? "now" : `${Math.round(st.etaS / 60)} min`) : null,
        locationText: st?.lastPingAt ? `Location ${agoText(st.lastPingAt, now)}` : "No location yet",
        checkInText: !dev
          ? null
          : dev.lastSyncAt
            ? `Phone checked in ${agoText(dev.lastSyncAt, now)}`
            : "Phone never checked in",
        batteryText: dev?.battery == null ? null : `${Math.round(dev.battery)}%${dev.charging ? " · charging" : ""}`,
        serviceName: st?.serviceId ? (serviceName.get(st.serviceId) ?? null) : null,
        deviceId: dev?.id ?? null,
        phoneLabel: dev?.label ?? null,
        sources: all.map((p) => ({
          deviceId: p.device.id,
          label: `${p.device.label} · ${SOURCE[p.device.appVersion ?? ""] ?? "app"}`,
          text: p.lastFixAt ? `location ${agoText(p.lastFixAt, now)}` : "no location yet",
          silent: p.silent,
        })),
        silencedUntilText: silence ? istHHMM(silence.endsAt) : null,
        problems: problems.map(line),
        onBreak: !!brk,
        breakText: brk ? (brkEnd ? `On break till ${istHHMM(brkEnd)}` : "On break") : null,
        position: st?.lat != null && st.lng != null ? { lat: st.lat, lng: st.lng } : null,
      };
    })
    .sort((a, b) => Number(b.problems.length > 0) - Number(a.problems.length > 0) || a.name.localeCompare(b.name));

  // one per service: a service shows up on both days of the schedule
  const soonest = new Map<string, ScheduleDay["services"][number]["departures"][number]>();
  for (const d of input.schedule.flatMap((day) => day.services.flatMap((s) => s.departures))) {
    const cur = soonest.get(d.serviceId);
    if (d.at >= now && (!cur || d.at < cur.at)) soonest.set(d.serviceId, d);
  }
  const nextDepartures = [...soonest.values()]
    .sort((a, b) => a.at - b.at)
    .map((d) => ({
      serviceId: d.serviceId,
      serviceName: serviceName.get(d.serviceId) ?? "Service",
      date: d.date,
      planned: d.planned,
      atText: istHHMM(d.at),
    }));

  return { cards, otherProblems: input.problems.filter((p) => !used.has(p)).map(line), nextDepartures };
}

function phaseText(phase: Phase, st: VehicleState | undefined, spotName: Map<string, string>): string {
  if (phase === "at_spot") return st?.spotId ? `At ${spotName.get(st.spotId) ?? "a spot"}` : "At a spot";
  if (phase === "en_route") return st?.nextSpotId ? `To ${spotName.get(st.nextSpotId) ?? "next spot"}` : "On the road";
  if (phase === "offline") return "Offline";
  // a position off duty only exists in ops tracking hours (between shifts)
  if (st?.lat == null) return "Off duty";
  const inside = st.geofence?.insideSpotId;
  return `Off duty · ${inside ? `at ${spotName.get(inside) ?? "a spot"}` : "on the road"}`;
}
