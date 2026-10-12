import { describe, expect, it } from "vitest";
import { fmtDelay, fmtDuration, heatmap, heatTone, insightsRange } from "./view";

// 2026-10-12 23:00 IST = 17:30Z
const NOW = new Date("2026-10-12T17:30:00Z");

describe("insightsRange", () => {
  it("defaults to the last 7 IST days ending today", () => {
    expect(insightsRange({}, NOW)).toEqual({ from: "2026-10-06", to: "2026-10-12" });
  });

  it("uses today in IST, not UTC", () => {
    // 2026-10-12 19:00Z is 00:30 on the 13th in IST
    expect(insightsRange({}, new Date("2026-10-12T19:00:00Z")).to).toBe("2026-10-13");
  });

  it("keeps valid dates and swaps a reversed range", () => {
    expect(insightsRange({ from: "2026-10-01", to: "2026-10-05" }, NOW)).toEqual({
      from: "2026-10-01",
      to: "2026-10-05",
    });
    expect(insightsRange({ from: "2026-10-05", to: "2026-10-01" }, NOW)).toEqual({
      from: "2026-10-01",
      to: "2026-10-05",
    });
  });

  it("ignores junk and impossible dates", () => {
    expect(insightsRange({ from: "nope", to: "2026-13-40" }, NOW)).toEqual({ from: "2026-10-06", to: "2026-10-12" });
    expect(insightsRange({ from: ["2026-10-01"], to: undefined }, NOW).from).toBe("2026-10-06");
  });
});

describe("heatmap", () => {
  const rows = [
    { spotId: "a", slot: "10:20", weekday: 1, avgMin: 4, p80Min: 6, n: 3 },
    { spotId: "a", slot: "09:40", weekday: 7, avgMin: 8, p80Min: 12, n: 6 },
    { spotId: "a", slot: "09:40", weekday: 1, avgMin: 1, p80Min: 2, n: 2 },
    { spotId: "b", slot: "08:00", weekday: 3, avgMin: 0, p80Min: 0, n: 1 },
  ];

  it("gives one row per slot in time order, with Monday..Sunday cells", () => {
    const grid = heatmap(rows, "a");
    expect(grid.map((r) => r.slot)).toEqual(["09:40", "10:20"]);
    expect(grid[0]?.days).toHaveLength(7);
    expect(grid[0]?.days[0]?.avgMin).toBe(1); // Monday
    expect(grid[0]?.days[6]?.p80Min).toBe(12); // Sunday
    expect(grid[0]?.days[3]).toBeNull();
    expect(grid[1]?.days.filter(Boolean)).toHaveLength(1);
  });

  it("only includes the asked spot", () => {
    expect(heatmap(rows, "b").map((r) => r.slot)).toEqual(["08:00"]);
    expect(heatmap(rows, "zzz")).toEqual([]);
  });
});

describe("heatTone", () => {
  it("is ok within 3 min either way, then warn, then bad", () => {
    expect(heatTone(0)).toBe("ok");
    expect(heatTone(-3)).toBe("ok");
    expect(heatTone(3)).toBe("ok");
    expect(heatTone(5)).toBe("warn");
    expect(heatTone(-6)).toBe("warn");
    expect(heatTone(8.5)).toBe("bad");
  });
});

describe("fmtDelay", () => {
  it("signs whole minutes and calls tiny delays on time", () => {
    expect(fmtDelay(8.2)).toBe("+8 min");
    expect(fmtDelay(-2)).toBe("−2 min");
    expect(fmtDelay(0.3)).toBe("on time");
  });
});

describe("fmtDuration", () => {
  it("reads seconds as people say them", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(45)).toBe("45 s");
    expect(fmtDuration(90)).toBe("2 min");
    expect(fmtDuration(540)).toBe("9 min");
    expect(fmtDuration(3900)).toBe("1 h 05 min");
  });
});
