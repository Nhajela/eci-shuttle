import { describe, expect, it } from "vitest";
import { distanceM, overlapWarnings } from "./overlap";

const riva = { id: "riva", name: "Riva", lat: 15.6634, lng: 73.7137, radiusM: 75, archivedAt: null };
const circle = { id: "circle", name: "Circle", lat: 15.6512, lng: 73.7178, radiusM: 75, archivedAt: null };

describe("distanceM", () => {
  it("is 0 for the same point", () => {
    expect(distanceM(riva, riva)).toBe(0);
  });
  it("is about 111 km per degree of latitude", () => {
    const d = distanceM({ lat: 15, lng: 73 }, { lat: 16, lng: 73 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe("overlapWarnings", () => {
  it("is empty when the circles are apart", () => {
    expect(overlapWarnings({ lat: riva.lat, lng: riva.lng, radiusM: 75 }, [circle])).toEqual([]);
  });

  it("names a spot whose circle overlaps, with the distance", () => {
    const near = { lat: riva.lat + 0.0005, lng: riva.lng, radiusM: 50 }; // ~56 m north
    const w = overlapWarnings(near, [riva, circle]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Riva/);
    expect(w[0]).toMatch(/56 m apart/);
  });

  it("skips the spot being edited and archived spots", () => {
    const archived = { ...riva, id: "old", name: "Old Riva", archivedAt: new Date() };
    expect(overlapWarnings({ id: "riva", lat: riva.lat, lng: riva.lng, radiusM: 75 }, [riva, archived])).toEqual([]);
  });

  it("warns about overlap when the centres are closer than the sum of the radii", () => {
    const d = distanceM(riva, circle); // ~1.4 km; small radii keep the exit-hysteresis rule out of play
    expect(overlapWarnings({ lat: riva.lat, lng: riva.lng, radiusM: Math.ceil(d) - 74 }, [circle])[0]).toMatch(
      /Overlaps Circle/,
    );
  });

  it("warns when a shuttle at one spot would never leave the other (exit radius x 1.5)", () => {
    const at110m = { lat: riva.lat + 110 / 111_195, lng: riva.lng, radiusM: 30 }; // circles apart: 105 < 110
    const w = overlapWarnings(at110m, [riva]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Too close to Riva \(110 m\)/);
    const at115m = { ...at110m, lat: riva.lat + 115 / 111_195 }; // beyond 75 x 1.5 = 112.5 m
    expect(overlapWarnings(at115m, [riva])).toEqual([]);
  });
});
