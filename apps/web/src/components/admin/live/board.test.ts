import { istToEpoch } from "@eci-shuttle/shared";
import { describe, expect, it } from "vitest";
import type { Device, Directive, Service, Spot, Vehicle, VehicleState } from "@/db/types";
import type { Problem } from "@/services/alerts/watchdog";
import type { PhoneHealth } from "@/services/devices/phones";
import { agoText, type BoardInput, buildBoard } from "./board";

const NOW = istToEpoch("2026-10-12", "09:30");
const WS = "w1";

const spot = (id: string, shortName: string): Spot =>
  ({ id, shortName, name: shortName, lat: 15.6, lng: 73.7 }) as Spot;
const vehicle = (id: string, name: string, over: Partial<Vehicle> = {}): Vehicle =>
  ({ id, name, workspaceId: WS, active: true, colour: null, ...over }) as Vehicle;
const state = (vehicleId: string, over: Partial<VehicleState> = {}): VehicleState =>
  ({
    vehicleId,
    workspaceId: WS,
    serviceId: null,
    phase: "off_duty",
    spotId: null,
    nextSpotId: null,
    etaS: null,
    lastPingAt: null,
    lat: null,
    lng: null,
    offRoute: false,
    ...over,
  }) as VehicleState;
const phone = (deviceId: string, v: Vehicle | null, over: Partial<Device> = {}, directives: Directive[] = []) =>
  ({
    device: { id: deviceId, label: `${deviceId} phone`, battery: null, charging: null, ...over } as Device,
    vehicle: v,
    activeDirectives: directives,
  }) as PhoneHealth;
const service = (id: string, name: string): Service => ({ id, name }) as Service;
const dep = (serviceId: string, date: string, hhmm: string) => ({
  serviceId,
  date,
  at: istToEpoch(date, hhmm),
  planned: hhmm,
  shiftedMin: 0,
  added: false,
});
const problem = (over: Partial<Problem>): Problem => ({
  kind: "silent",
  workspaceId: WS,
  vehicleId: null,
  deviceId: null,
  since: new Date(NOW - 600_000),
  message: "something",
  ...over,
});

const base = (over: Partial<BoardInput> = {}): BoardInput => ({
  vehicles: [],
  states: [],
  phones: [],
  problems: [],
  schedule: [],
  spots: [spot("riva", "Riva"), spot("circle", "Circle")],
  ...over,
});

describe("agoText", () => {
  it("says never for no ping, seconds under a minute, minutes under an hour, IST time after", () => {
    expect(agoText(null, NOW)).toBe("never");
    expect(agoText(new Date(NOW - 12_000), NOW)).toBe("12s ago");
    expect(agoText(new Date(NOW - 4 * 60_000), NOW)).toBe("4 min ago");
    expect(agoText(new Date(istToEpoch("2026-10-12", "07:05")), NOW)).toBe("at 07:05");
    expect(agoText(new Date(istToEpoch("2026-10-11", "07:05")), NOW)).toBe("Sun 11 Oct, 07:05");
  });
});

describe("buildBoard", () => {
  it("describes each active vehicle: phase, ETA, last seen, battery, service, phone", () => {
    const bus = vehicle("v1", "Bus 1");
    const out = buildBoard(
      base({
        vehicles: [bus, vehicle("v2", "Old van", { active: false })],
        states: [
          state("v1", {
            phase: "en_route",
            nextSpotId: "circle",
            etaS: 6 * 60 + 20,
            lastPingAt: new Date(NOW - 12_000),
            serviceId: "s1",
            lat: 15.61,
            lng: 73.71,
          }),
        ],
        phones: [phone("d1", bus, { battery: 64.4, charging: true, lastSyncAt: new Date(NOW - 20_000) })],
        schedule: [
          {
            date: "2026-10-12",
            services: [{ service: service("s1", "Riva ↔ Circle"), exceptions: [], vehicles: [], departures: [] }],
          },
        ],
      }),
      NOW,
    );
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]).toMatchObject({
      vehicleId: "v1",
      name: "Bus 1",
      phase: "en_route",
      phaseText: "To Circle",
      etaText: "6 min",
      locationText: "Location 12s ago",
      checkInText: "Phone checked in 20s ago",
      batteryText: "64% · charging",
      serviceName: "Riva ↔ Circle",
      deviceId: "d1",
      phoneLabel: "d1 phone",
      position: { lat: 15.61, lng: 73.71 },
      silencedUntilText: null,
    });
  });

  it("handles a vehicle with no state and no phone", () => {
    const out = buildBoard(base({ vehicles: [vehicle("v1", "Bus 1")] }), NOW);
    expect(out.cards[0]).toMatchObject({
      phase: "off_duty",
      phaseText: "Off duty",
      etaText: null,
      locationText: "No location yet",
      checkInText: null,
      batteryText: null,
      deviceId: null,
      position: null,
    });
  });

  it("an off-duty vehicle tracked in ops hours shows its last position, and where it is", () => {
    const gf = (insideSpotId: string | null) =>
      ({ insideSpotId, enteredAt: null, candidateSpotId: null, candidateSince: null, lastFixAt: null }) as const;
    const out = buildBoard(
      base({
        vehicles: [vehicle("v1", "Bus 1"), vehicle("v2", "Bus 2")],
        states: [
          state("v1", { lat: 15.6, lng: 73.7, geofence: gf("riva"), lastPingAt: new Date(NOW - 60_000) }),
          state("v2", { lat: 15.65, lng: 73.75, geofence: gf(null), lastPingAt: new Date(NOW - 60_000) }),
        ],
      }),
      NOW,
    );
    expect(out.cards[0]).toMatchObject({
      phase: "off_duty",
      phaseText: "Off duty · at Riva",
      locationText: "Location 1 min ago",
      position: { lat: 15.6, lng: 73.7 },
    });
    expect(out.cards[1]).toMatchObject({ phaseText: "Off duty · on the road", position: { lat: 15.65, lng: 73.75 } });
  });

  it("shows a phone that checks in without a GPS fix as checked in, not as never seen", () => {
    const bus = vehicle("v1", "Bus 1");
    const out = buildBoard(
      base({
        vehicles: [bus],
        states: [state("v1")],
        phones: [phone("d1", bus, { battery: 80, lastSyncAt: new Date(NOW - 3 * 60_000) })],
      }),
      NOW,
    );
    expect(out.cards[0]).toMatchObject({ locationText: "No location yet", checkInText: "Phone checked in 3 min ago" });
    const never = buildBoard(base({ vehicles: [bus], phones: [phone("d1", bus, { lastSyncAt: null })] }), NOW);
    expect(never.cards[0].checkInText).toBe("Phone never checked in");
  });

  it("names the spot when at a spot, and shows ETA under a minute as 'now'", () => {
    const out = buildBoard(
      base({
        vehicles: [vehicle("v1", "Bus 1"), vehicle("v2", "Bus 2")],
        states: [
          state("v1", { phase: "at_spot", spotId: "riva" }),
          state("v2", { phase: "en_route", nextSpotId: "riva", etaS: 40 }),
        ],
      }),
      NOW,
    );
    expect(out.cards.map((c) => [c.phaseText, c.etaText])).toEqual([
      ["At Riva", null],
      ["To Riva", "now"],
    ]);
  });

  it("shows a running silence directive in IST", () => {
    const bus = vehicle("v1", "Bus 1");
    const silence = {
      kind: "silence_until",
      startsAt: new Date(NOW - 60_000),
      endsAt: new Date(istToEpoch("2026-10-12", "10:30")),
      cancelledAt: null,
    } as Directive;
    const out = buildBoard(base({ vehicles: [bus], phones: [phone("d1", bus, {}, [silence])] }), NOW);
    expect(out.cards[0].silencedUntilText).toBe("10:30");
  });

  it("puts problems on their vehicle (by vehicle or by its phone), problem vehicles first, rest by name", () => {
    const a = vehicle("va", "A bus");
    const b = vehicle("vb", "B bus");
    const c = vehicle("vc", "C bus");
    const out = buildBoard(
      base({
        vehicles: [a, b, c],
        phones: [phone("dc", c)],
        problems: [
          problem({ kind: "low_battery", deviceId: "dc", message: "C phone at 12%" }),
          problem({ kind: "silent", vehicleId: "vb", message: "B bus has been silent" }),
          problem({ kind: "permission_lost", deviceId: "loose", message: "Spare phone lost location" }),
        ],
      }),
      NOW,
    );
    expect(out.cards.map((x) => x.name)).toEqual(["B bus", "C bus", "A bus"]);
    expect(out.cards[0].problems).toEqual([{ kind: "silent", message: "B bus has been silent" }]);
    expect(out.cards[1].problems).toEqual([{ kind: "low_battery", message: "C phone at 12%" }]);
    expect(out.otherProblems).toEqual([{ kind: "permission_lost", message: "Spare phone lost location" }]);
  });

  it("lists each service's next departure (including last night's run past midnight), soonest first", () => {
    const out = buildBoard(
      base({
        schedule: [
          {
            date: "2026-10-11",
            services: [
              {
                service: service("party", "Party"),
                exceptions: [],
                vehicles: [],
                // cross-midnight run belonging to yesterday, already over
                departures: [dep("party", "2026-10-11", "23:30")],
              },
            ],
          },
          {
            date: "2026-10-12",
            services: [
              {
                service: service("s1", "Riva ↔ Circle"),
                exceptions: [],
                vehicles: [],
                departures: [
                  dep("s1", "2026-10-12", "09:20"),
                  dep("s1", "2026-10-12", "09:40"),
                  dep("s1", "2026-10-12", "10:00"),
                ],
              },
              {
                service: service("s2", "Early"),
                exceptions: [],
                vehicles: [],
                departures: [dep("s2", "2026-10-12", "09:30"), dep("s2", "2026-10-12", "11:00")],
              },
            ],
          },
        ],
      }),
      NOW,
    );
    expect(out.nextDepartures).toEqual([
      { serviceId: "s2", serviceName: "Early", date: "2026-10-12", planned: "09:30", atText: "09:30" },
      { serviceId: "s1", serviceName: "Riva ↔ Circle", date: "2026-10-12", planned: "09:40", atText: "09:40" },
    ]);
  });

  it("gives one next departure per service even when it appears on both days", () => {
    const party = service("party", "Party");
    const out = buildBoard(
      base({
        schedule: [
          {
            date: "2026-10-11",
            services: [
              {
                service: party,
                exceptions: [],
                vehicles: [],
                departures: [{ ...dep("party", "2026-10-11", "23:30"), at: NOW + 60_000 }],
              },
            ],
          },
          {
            date: "2026-10-12",
            services: [
              { service: party, exceptions: [], vehicles: [], departures: [dep("party", "2026-10-12", "23:30")] },
            ],
          },
        ],
      }),
      NOW,
    );
    expect(out.nextDepartures).toEqual([
      { serviceId: "party", serviceName: "Party", date: "2026-10-11", planned: "23:30", atText: "09:31" },
    ]);
  });

  it("shows a shifted departure at its shifted time but cancels it by its planned time", () => {
    const shifted = { ...dep("s1", "2026-10-12", "09:40"), at: istToEpoch("2026-10-12", "09:50"), shiftedMin: 10 };
    const out = buildBoard(
      base({
        schedule: [
          {
            date: "2026-10-12",
            services: [{ service: service("s1", "Loop"), exceptions: [], vehicles: [], departures: [shifted] }],
          },
        ],
      }),
      NOW,
    );
    expect(out.nextDepartures[0]).toMatchObject({ planned: "09:40", atText: "09:50" });
  });
});
