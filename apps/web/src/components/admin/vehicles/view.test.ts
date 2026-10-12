import { describe, expect, it } from "vitest";
import { currentPhone, currentService, tripLine, vehicleFields } from "./view";

const now = Date.parse("2026-10-12T06:00:00Z"); // 11:30 IST
const at = (iso: string) => new Date(iso);

describe("currentPhone", () => {
  const dev = (id: string, revokedAt: Date | null = null) => ({ id, label: `Phone ${id}`, revokedAt });
  it("is the non-revoked phone assigned to the vehicle", () => {
    const phones = [
      { device: dev("a"), vehicle: { id: "v2" } },
      { device: dev("b", at("2026-10-11T00:00:00Z")), vehicle: { id: "v1" } },
      { device: dev("c"), vehicle: { id: "v1" } },
    ];
    expect(currentPhone(phones, "v1")?.id).toBe("c");
    expect(currentPhone(phones, "v3")).toBeNull();
  });
});

describe("currentService", () => {
  const day = (vehicles: { vehicleId: string; startsAt: Date; endsAt: Date }[]) => ({
    services: [{ service: { name: "Riva ↔ Circle" }, vehicles }],
  });
  it("names the service the vehicle is running now, with its IST end", () => {
    const days = [day([{ vehicleId: "v1", startsAt: at("2026-10-12T02:30:00Z"), endsAt: at("2026-10-12T12:30:00Z") }])];
    expect(currentService(days, "v1", now)).toEqual({ name: "Riva ↔ Circle", until: "18:00" });
  });
  it("is null outside every assignment (end is exclusive)", () => {
    const days = [
      day([{ vehicleId: "v1", startsAt: at("2026-10-12T02:30:00Z"), endsAt: at("2026-10-12T06:00:00Z") }]),
      day([{ vehicleId: "v2", startsAt: at("2026-10-12T02:30:00Z"), endsAt: at("2026-10-12T12:30:00Z") }]),
    ];
    expect(currentService(days, "v1", now)).toBeNull();
  });
});

describe("tripLine", () => {
  const base = { departedAt: at("2026-10-12T04:10:00Z"), fromName: "Riva", toName: "Circle" as string | null };
  it("shows IST departure, legs and duration", () => {
    expect(tripLine({ ...base, arrivedAt: at("2026-10-12T04:35:00Z"), durationS: 1500, quality: "clean" })).toBe(
      "Mon 12 Oct, 09:40 · Riva → Circle · 25 min",
    );
  });
  it("marks an open trip and a non-clean path", () => {
    expect(tripLine({ ...base, toName: null, arrivedAt: null, durationS: null, quality: "gap" })).toBe(
      "Mon 12 Oct, 09:40 · Riva → … · on the way · gap in tracking",
    );
    expect(tripLine({ ...base, arrivedAt: at("2026-10-12T04:35:00Z"), durationS: 1500, quality: "off_route" })).toBe(
      "Mon 12 Oct, 09:40 · Riva → Circle · 25 min · off route",
    );
  });
});

describe("vehicleFields", () => {
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  it("maps a create form, blanks to null", () => {
    expect(vehicleFields(form({ name: " Van 1 ", plate: "", colour: "#ff0000", capacity: "", active: "on" }))).toEqual({
      name: "Van 1",
      plate: null,
      colour: "#ff0000",
      capacity: null,
      active: true,
    });
  });
  it("maps an edit form with id, version, number capacity and unchecked active", () => {
    expect(vehicleFields(form({ vehicleId: "v1", version: "3", name: "Van", plate: "GA 01", capacity: "12" }))).toEqual(
      {
        vehicleId: "v1",
        version: 3,
        name: "Van",
        plate: "GA 01",
        colour: null,
        capacity: 12,
        active: false,
      },
    );
  });
  it("drops the picked colour when 'no colour' is ticked", () => {
    expect(vehicleFields(form({ name: "Van", colour: "#000000", noColour: "on" })).colour).toBeNull();
  });
});
