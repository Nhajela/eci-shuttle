import type { PublicSpot, PublicStatus } from "@eci-shuttle/shared";
import { line } from "@tests/factories/bot-attendee";
import { describe, expect, it } from "vitest";
import {
  type AlertVehicle,
  groupWaiting,
  matchNeed,
  needSpots,
  notRunningText,
  requesterName,
  vehicleLine,
  waitingAlertText,
} from "./need-text";

const at = (iso: string) => new Date(iso);
const veh = (over: Partial<AlertVehicle>): AlertVehicle => ({
  name: "Shuttle 1",
  phase: "at_spot",
  spotName: "Circle",
  nextSpotName: null,
  etaS: null,
  lastPingAt: null,
  ...over,
});

describe("vehicleLine", () => {
  it("each phase in plain words", () => {
    expect(vehicleLine(veh({}))).toBe("Shuttle 1: at Circle");
    expect(vehicleLine(veh({ phase: "en_route", spotName: null, nextSpotName: "Riva", etaS: 230 }))).toBe(
      "Shuttle 1: on the way to Riva · about 4 min",
    );
    expect(vehicleLine(veh({ phase: "en_route", nextSpotName: null }))).toBe("Shuttle 1: on the way");
    expect(vehicleLine(veh({ phase: "offline", lastPingAt: at("2026-10-13T04:21:00Z") }))).toBe(
      "Shuttle 1: offline (last seen 09:51)",
    );
    expect(vehicleLine(veh({ phase: "off_duty" }))).toBe("Shuttle 1: off duty");
    expect(vehicleLine(veh({ phase: null }))).toBe("Shuttle 1: no position yet");
  });

  it("a break, with or without an end; names escaped", () => {
    expect(vehicleLine(veh({ breakUntil: at("2026-10-13T06:45:00Z") }))).toBe(
      "Shuttle 1: at Circle · on a break till 12:15",
    );
    expect(vehicleLine(veh({ name: "Bus <2>", phase: "offline", breakUntil: null }))).toBe(
      "Bus &lt;2&gt;: offline · on a break",
    );
  });
});

describe("waitingAlertText", () => {
  it("count, up to 5 names then +N more, since when (IST), one line per vehicle", () => {
    const waiting = ["Asha", "Ben", "Chi", "Dev", "Eli", "Fay", "Gus"].map((name) => ({ name, to: "Circle" }));
    expect(
      waitingAlertText({
        spotName: "Riva",
        waiting,
        since: at("2026-10-13T06:12:00Z"),
        vehicles: [veh({}), veh({ name: "Shuttle 2", phase: "offline", lastPingAt: at("2026-10-13T04:21:00Z") })],
      }),
    ).toBe(
      "🙋 <b>7 people waiting at Riva</b>\n" +
        "Asha → Circle, Ben → Circle, Chi → Circle, Dev → Circle, Eli → Circle (+2 more) · waiting since 11:42\n" +
        "Shuttle 1: at Circle\n" +
        "Shuttle 2: offline (last seen 09:51)",
    );
  });

  it("escapes people's names and says so when there are no vehicles", () => {
    const html = waitingAlertText({
      spotName: "Riva",
      waiting: [{ name: "<b>x</b>", to: "Circle" }],
      since: at("2026-10-13T06:12:00Z"),
      vehicles: [],
    });
    expect(html).toBe(
      "🙋 <b>1 person waiting at Riva</b>\n&lt;b&gt;x&lt;/b&gt; → Circle · waiting since 11:42\nNo active vehicles.",
    );
  });
});

describe("needSpots / notRunningText", () => {
  const spot = (id: string, answers = [line()]): PublicSpot => ({
    spotId: id,
    name: id,
    shortName: id,
    notices: [],
    answers,
    schedule: { notices: [], rows: [], loops: [] },
  });
  const st = (spots: PublicSpot[]): PublicStatus => ({
    workspace: { slug: "eci", name: "ECI", isLive: true },
    generatedAt: "2026-10-13T05:30:00.000Z",
    notices: [],
    spots,
  });
  const first = (iso: string, label: string) =>
    line({ kind: "timetable", minutes: null, phaseText: "first shuttle today", nextAt: iso, nextAtLabel: label });
  const done = line({ kind: "none", minutes: null, phaseText: "no more shuttles today" });

  it("stops with a shuttle out now: live, between departures or on a break", () => {
    const out = needSpots(
      st([
        spot("a"),
        spot("b", [line({ kind: "timetable", minutes: null, phaseText: "on a short break" })]),
        spot("c", [done]),
      ]),
    );
    expect(out.spots.map((s) => s.spotId)).toEqual(["a", "b"]);
    expect(out.nextStart).toBeNull();
  });

  it("none running: the earliest start still to come", () => {
    const out = needSpots(
      st([
        spot("a", [done, first("2026-10-13T11:30:00.000Z", "17:00")]),
        spot("b", [first("2026-10-13T06:30:00.000Z", "12:00")]),
      ]),
    );
    expect(out).toEqual({ spots: [], nextStart: "12:00" });
    expect(notRunningText(out.nextStart)).toBe("No shuttle is running right now. The next one starts at 12:00.");
    expect(notRunningText(needSpots(st([spot("a", [done])])).nextStart)).toBe("No shuttle is running right now.");
  });
});

describe("matchNeed", () => {
  const stops = [
    { name: "Riva Beach Resort", shortName: "Riva" },
    { name: "Circle co-work", shortName: "Circle" },
    { name: "Nanu Resort", shortName: "Nanu" },
  ];
  const [riva, circle] = stops;
  it("two stops in one go, by short name or full name, with or without from / to / →", () => {
    expect(matchNeed("riva circle", stops)).toEqual({ from: riva, to: circle });
    expect(matchNeed("from Riva Beach Resort to Circle co-work", stops)).toEqual({ from: riva, to: circle });
    expect(matchNeed("Riva → circle", stops)).toEqual({ from: riva, to: circle });
    expect(matchNeed("riva->circle", stops)).toEqual({ from: riva, to: circle });
  });
  it("one stop = where they are; unknown words", () => {
    expect(matchNeed("RIVA", stops)).toEqual({ from: riva });
    expect(matchNeed("riva beach resort", stops)).toEqual({ from: riva });
    expect(matchNeed("the moon", stops)).toEqual({ unknown: "the moon" });
    expect(matchNeed("riva moon", stops)).toEqual({ unknown: "riva moon" });
  });
});

describe("requesterName / groupWaiting", () => {
  it("names", () => {
    expect(requesterName({ firstName: "Asha", lastName: null, username: "asha" })).toBe("Asha (@asha)");
    expect(requesterName({ firstName: null, lastName: null, username: "asha" })).toBe("@asha");
    expect(requesterName({ firstName: null, lastName: null, username: null })).toBe("Someone");
  });

  it("per stop, oldest first, stops by longest wait", () => {
    const row = (requestId: string, spotId: string, min: number) => ({
      requestId,
      spotId,
      spotName: spotId,
      name: requestId,
      toSpotName: "X",
      since: new Date(min * 60_000),
    });
    const out = groupWaiting([row("r3", "riva", 3), row("c1", "circle", 1), row("r2", "riva", 2)]);
    expect(out.map((g) => [g.spotId, g.count, g.people.map((p) => p.requestId)])).toEqual([
      ["circle", 1, ["c1"]],
      ["riva", 2, ["r2", "r3"]],
    ]);
  });
});
