import { describe, expect, it, vi } from "vitest";
import { generatePath } from "./routes";

const riva = { lat: 15.6301, lng: 73.7356 };
const circle = { lat: 15.6402, lng: 73.7301 };

const osrmOk = (coords: [number, number][]) =>
  vi.fn(async () => new Response(JSON.stringify({ code: "Ok", routes: [{ geometry: { coordinates: coords } }] })));

describe("generatePath", () => {
  it("asks OSRM for the points in lng,lat order and returns its road path as lat/lng", async () => {
    const f = osrmOk([
      [73.7356, 15.6301],
      [73.734, 15.633],
      [73.732, 15.637],
      [73.7301, 15.6402],
    ]);
    const r = await generatePath([riva, circle], f as unknown as typeof fetch);
    const url = String((f.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("router.project-osrm.org/route/v1/driving/73.7356,15.6301;73.7301,15.6402");
    expect(url).toContain("overview=full");
    expect(url).toContain("geometries=geojson");
    expect(r.source).toBe("osrm");
    expect(r.path).toHaveLength(4);
    expect(r.path[1]).toEqual({ lat: 15.633, lng: 73.734 });
    expect(r.spotPathIdx).toEqual([0, 3]);
  });

  it("loop: the repeated first spot maps to the end of the path, not back to index 0", async () => {
    const f = osrmOk([
      [73.7356, 15.6301],
      [73.733, 15.635],
      [73.7301, 15.6402],
      [73.731, 15.636],
      [73.7356, 15.6302],
    ]);
    const r = await generatePath([riva, circle, riva], f as unknown as typeof fetch);
    expect(r.spotPathIdx).toEqual([0, 2, 4]);
  });

  it("loop: pins the ends even when OSRM snaps the end vertex closer to the first spot than the start vertex", async () => {
    const f = osrmOk([
      [73.7358, 15.6303],
      [73.733, 15.635],
      [73.7301, 15.6402],
      [73.731, 15.636],
      [73.7356, 15.6301],
    ]);
    const r = await generatePath([riva, circle, riva], f as unknown as typeof fetch);
    expect(r.spotPathIdx).toEqual([0, 2, 4]);
  });

  it.each([
    ["network error", vi.fn(async () => Promise.reject(new Error("offline")))],
    ["http 500", vi.fn(async () => new Response("boom", { status: 500 }))],
    ["code NoRoute", vi.fn(async () => new Response(JSON.stringify({ code: "NoRoute", routes: [] })))],
    ["bad json", vi.fn(async () => new Response("not json"))],
  ])("falls back to straight segments on %s", async (_, f) => {
    const r = await generatePath([riva, circle, riva], f as unknown as typeof fetch);
    expect(r).toEqual({ path: [riva, circle, riva], source: "straight", spotPathIdx: [0, 1, 2] });
  });

  it("gives up on a hung OSRM after the timeout and falls back", async () => {
    vi.useFakeTimers();
    try {
      const hang = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      );
      const p = generatePath([riva, circle], hang as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await p).source).toBe("straight");
    } finally {
      vi.useRealTimers();
    }
  });
});
