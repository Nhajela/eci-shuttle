import { describe, expect, it } from "vitest";
import { matchDepartures } from "./matchDepartures";

const T0 = Date.UTC(2026, 9, 12, 3, 30); // 09:00 IST
const min = (m: number) => T0 + m * 60_000;
const p = (id: string, m: number) => ({ id, at: min(m) });

describe("matchDepartures", () => {
  it("each actual takes the nearest planned within ±25 min", () => {
    const r = matchDepartures([p("p0", 0), p("p40", 40)], [p("a3", 3), p("a38", 38)]);
    expect(r.matches).toEqual([
      { plannedId: "p0", actualId: "a3", delayMin: 3, missed: false },
      { plannedId: "p40", actualId: "a38", delayMin: -2, missed: false },
    ]);
    expect(r.unmatchedActualIds).toEqual([]);
  });

  it("no actuals → every planned is missed", () => {
    const r = matchDepartures([p("p0", 0), p("p40", 40)], []);
    expect(r.matches).toEqual([
      { plannedId: "p0", actualId: null, delayMin: null, missed: true },
      { plannedId: "p40", actualId: null, delayMin: null, missed: true },
    ]);
    expect(r.unmatchedActualIds).toEqual([]);
  });

  it("actual 26 min after the only planned → planned missed, actual unmatched", () => {
    const r = matchDepartures([p("p0", 0)], [p("a26", 26)]);
    expect(r.matches[0]).toMatchObject({ actualId: null, missed: true });
    expect(r.unmatchedActualIds).toEqual(["a26"]);
  });

  it("exactly 25 min is inside the tolerance", () => {
    expect(matchDepartures([p("p0", 0)], [p("a", 25)]).matches[0]).toMatchObject({ actualId: "a", delayMin: 25 });
    expect(matchDepartures([p("p0", 0)], [p("a", -25)]).matches[0]).toMatchObject({ actualId: "a", delayMin: -25 });
  });

  it("greedy in actual time order: a late first run can take a slot a later run was closer to", () => {
    // a12 is nearest p20 (8 vs 12) and takes it.
    // a19 would be nearest p20 too (1), but a12 got there first, so a19 falls back to p0 (19).
    const r = matchDepartures([p("p0", 0), p("p20", 20)], [p("a12", 12), p("a19", 19)]);
    expect(r.matches).toEqual([
      { plannedId: "p0", actualId: "a19", delayMin: 19, missed: false },
      { plannedId: "p20", actualId: "a12", delayMin: -8, missed: false },
    ]);
  });

  it("tie on distance → earlier planned", () => {
    const r = matchDepartures([p("p0", 0), p("p20", 20)], [p("a10", 10)]);
    expect(r.matches).toEqual([
      { plannedId: "p0", actualId: "a10", delayMin: 10, missed: false },
      { plannedId: "p20", actualId: null, delayMin: null, missed: true },
    ]);
  });

  it("early departure gives negative delay", () => {
    expect(matchDepartures([p("p0", 0)], [p("a", -4)]).matches[0].delayMin).toBe(-4);
  });

  it("two actuals near one planned → the first takes it, the second takes the next or is unmatched", () => {
    const one = matchDepartures([p("p0", 0)], [p("a1", 1), p("a2", 2)]);
    expect(one.matches[0].actualId).toBe("a1");
    expect(one.unmatchedActualIds).toEqual(["a2"]);

    const two = matchDepartures([p("p0", 0), p("p20", 20)], [p("a1", 1), p("a2", 2)]);
    expect(two.matches.map((m) => m.actualId)).toEqual(["a1", "a2"]);
    expect(two.matches[1].delayMin).toBe(-18);
    expect(two.unmatchedActualIds).toEqual([]);
  });

  it("unsorted inputs give the same result", () => {
    const planned = [p("p0", 0), p("p20", 20), p("p60", 60)];
    const actual = [p("a12", 12), p("a19", 19), p("a90", 90), p("a61", 61)];
    const sorted = matchDepartures(planned, actual);
    const shuffled = matchDepartures([...planned].reverse(), [actual[2], actual[3], actual[1], actual[0]]);
    expect(shuffled).toEqual(sorted);
    expect(sorted.matches.map((m) => m.plannedId)).toEqual(["p0", "p20", "p60"]);
    expect(sorted.unmatchedActualIds).toEqual(["a90"]);
  });

  it("custom tolerance", () => {
    expect(matchDepartures([p("p0", 0)], [p("a", 6)], 5).matches[0].missed).toBe(true);
    expect(matchDepartures([p("p0", 0)], [p("a", 5)], 5).matches[0].actualId).toBe("a");
    expect(matchDepartures([p("p0", 0)], [p("a", 40)], 45).matches[0].actualId).toBe("a");
  });

  it("delayMin rounded to one decimal", () => {
    const r = matchDepartures([p("p0", 0)], [{ id: "a", at: T0 + 3 * 60_000 + 20_000 }]); // 3m20s
    expect(r.matches[0].delayMin).toBe(3.3);
    const early = matchDepartures([p("p0", 0)], [{ id: "a", at: T0 - 90_000 }]); // −1m30s
    expect(early.matches[0].delayMin).toBe(-1.5);
  });

  it("does not mutate its inputs", () => {
    const planned = [p("p20", 20), p("p0", 0)];
    const actual = [p("a19", 19), p("a12", 12)];
    matchDepartures(planned, actual);
    expect(planned.map((x) => x.id)).toEqual(["p20", "p0"]);
    expect(actual.map((x) => x.id)).toEqual(["a19", "a12"]);
  });
});
