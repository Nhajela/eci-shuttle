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

  it("only warns when the centres are closer than the sum of the radii", () => {
    const d = distanceM(riva, circle);
    expect(overlapWarnings({ lat: riva.lat, lng: riva.lng, radiusM: Math.floor(d) - 75 }, [circle])).toEqual([]);
    expect(overlapWarnings({ lat: riva.lat, lng: riva.lng, radiusM: Math.ceil(d) - 74 }, [circle])).toHaveLength(1);
  });
});
