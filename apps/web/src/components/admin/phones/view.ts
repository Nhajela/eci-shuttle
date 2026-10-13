/** admin-phones: pure display rules for a phone card. Times are IST; `now` is epoch ms. */
import { formatIst, istDate, istHHMM, istToEpoch } from "@eci-shuttle/shared";
import type { Device, Directive } from "@/db/types";
import type { PhoneHealth } from "@/services/devices/phones";

export type Tone = "ok" | "warn" | "bad" | "muted";

const LOW_BATTERY = 15;
const MAX_HOURS = 48; // the device schedule only covers 48h

/** Device fields the card may see. Never tokenHash or pushToken: this goes into the client payload for viewers too. */
const DEVICE_FIELDS = [
  "id",
  "label",
  "model",
  "appVersion",
  "updateId",
  "targetUpdateId",
  "battery",
  "charging",
  "lastSyncAt",
  "reportedMode",
  "reportedConfigVersion",
  "configVersion",
  "killedAt",
  "revokedAt",
] as const;
export type PhoneView = Omit<PhoneHealth, "device" | "vehicle"> & {
  device: Pick<Device, (typeof DEVICE_FIELDS)[number]>;
  vehicle: { id: string; name: string } | null;
};

/** Server → client: keep only what the card shows. */
export function toPhoneView(h: PhoneHealth): PhoneView {
  const device = Object.fromEntries(DEVICE_FIELDS.map((k) => [k, h.device[k]])) as PhoneView["device"];
  return { ...h, device, vehicle: h.vehicle && { id: h.vehicle.id, name: h.vehicle.name } };
}

/** Kill/revoke reach the phone in a sync response; until it syncs again (or reports the mode) it is still running. */
function pendingSince(d: PhoneView["device"], at: Date | null, mode: "killed" | "revoked"): Date | null {
  if (!at || d.reportedMode === mode || (d.lastSyncAt && d.lastSyncAt >= at)) return null;
  return at;
}

const MODE_LABEL: Record<string, string> = { active: "Tracking", idle: "Idle", unpaired: "Unpaired" };

/** Plain-English problems, in the order an admin should look at them. None for confirmed killed/revoked phones. */
export function phoneProblems(h: PhoneView, now: number): string[] {
  const d = h.device;
  const revokePending = pendingSince(d, d.revokedAt, "revoked");
  if (revokePending) return [`Revoke sent, phone hasn't synced since ${istWhen(revokePending, now)}`];
  if (d.revokedAt) return [];
  const killPending = pendingSince(d, d.killedAt, "killed");
  if (killPending) return [`Kill sent, phone hasn't synced since ${istWhen(killPending, now)}`];
  if (d.killedAt) return [];
  const out: string[] = [];
  // h.silent is the watchdog's rule (services/devices/phones), so the page and the alert agree
  if (h.silent) out.push(h.lastSyncAgoS === null ? "Silent" : `Silent for ${Math.floor(h.lastSyncAgoS / 60)} min`);
  if (h.modeMismatch) out.push(`Told ${h.desiredMode}, reports ${d.reportedMode ?? "nothing"}`);
  if (h.configBehind) out.push("Hasn't picked up the latest config");
  if (h.needsNewApk) out.push("Needs new APK");
  if (h.updateFailed) out.push("Update failed");
  if (d.battery !== null && d.battery < LOW_BATTERY && !d.charging) out.push(`Battery ${Math.round(d.battery)}%`);
  if (!h.permissionsOk && h.permissions) {
    const p = h.permissions;
    const missing = [
      p.location !== "always" && "location all the time",
      !p.preciseLocation && "precise location",
      !p.notifications && "notifications",
      !p.batteryOptimizationExempt && "battery exemption",
    ].filter(Boolean);
    out.push(`Missing: ${missing.join(", ")}`);
  }
  return out;
}

export function phoneStatus(h: PhoneView, now: number): { label: string; tone: Tone } {
  const d = h.device;
  if (d.revokedAt)
    return pendingSince(d, d.revokedAt, "revoked")
      ? { label: "Revoke pending", tone: "warn" }
      : { label: "Revoked", tone: "muted" };
  if (d.killedAt)
    return pendingSince(d, d.killedAt, "killed")
      ? { label: "Kill pending", tone: "warn" }
      : { label: "Killed", tone: "bad" };
  if (h.lastSyncAgoS === null) return { label: "Never synced", tone: "warn" };
  const label = MODE_LABEL[d.reportedMode ?? ""] ?? "Unknown";
  return { label, tone: phoneProblems(h, now).length ? "warn" : "ok" };
}

export function agoText(s: number | null): string {
  if (s === null) return "never";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** IST HH:MM when `t` is today (IST), otherwise "Tue 13 Oct, 09:00". */
export function istWhen(t: Date | number, now: number): string {
  return istDate(t) === istDate(now) ? istHHMM(t) : formatIst(t);
}

export function directiveText(d: Directive, now: number): string {
  const verb = d.kind === "silence_until" ? "Silenced" : d.kind === "force_active" ? "Forced active" : "Active window";
  return `${verb} until ${istWhen(d.endsAt, now)}`;
}

/** "Force active for N hours" → the ISO `until` the service takes. */
export function untilFromHours(now: number, hours: number): string {
  if (!(hours > 0 && hours <= MAX_HOURS)) throw new Error(`Pick between 0 and ${MAX_HOURS} hours.`);
  return new Date(now + hours * 3_600_000).toISOString();
}

/** A `<input type="datetime-local">` value, read as IST (admins are in Goa; the browser zone may differ). */
export function istInputToIso(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  if (!m) throw new Error("Pick a date and time.");
  return new Date(istToEpoch(m[1], m[2])).toISOString();
}

export const istInputValue = (now: number): string => `${istDate(now)}T${istHHMM(now)}`;
