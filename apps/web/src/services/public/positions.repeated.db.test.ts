import { makeOutAndBack } from "@tests/factories/repeated-stops";
import { testDb } from "@tests/helpers/db";
import { describe, expect, it } from "vitest";
import { vehicleState } from "@/db/schema";
import { PublicMap, publicPositions } from "./positions";

const db = () => testDb();
const NOW = new Date("2026-10-13T09:30:00+05:30");

async function vanAt(
  alongOf: (cumM: number[]) => number,
  from: "namaka" | "circle" | "riva",
  to: "circle" | "riva" | "nanu" | "namaka",
) {
  const w = await makeOutAndBack(db());
  await db()
    .insert(vehicleState)
    .values({
      vehicleId: w.vehicle.id,
      workspaceId: w.ws.id,
      serviceId: w.service.id,
      phase: "en_route",
      spotId: w.id[from],
      nextSpotId: w.id[to],
      alongM: alongOf(w.cumM),
      lat: 15.62,
      lng: 73.7,
      lastPingAt: new Date(NOW.getTime() - 20_000),
      since: new Date(NOW.getTime() - 60_000),
    });
  const map = PublicMap.parse(await publicPositions(db(), w.ws.id, NOW));
  return { w, van: map.vehicles[0] };
}

describe("public map for a route that repeats stops", () => {
  it("a van 200 m past Namaka heading back to Circle is on leg 3, not Riva → Circle", async () => {
    const { van } = await vanAt((c) => (c[3] as number) + 200, "namaka", "circle");
    expect(van).toMatchObject({ phase: "en_route", legIndex: 3 });
    expect(van?.legFraction).toBeGreaterThan(0.1);
    expect(van?.legFraction).toBeLessThan(0.3);
  });

  it("heading from Circle back to Riva is leg 4; from Circle out to Namaka is leg 2", async () => {
    const back = await vanAt((c) => (c[4] as number) + 500, "circle", "riva");
    expect(back.van).toMatchObject({ legIndex: 4 });
    expect(back.van?.legFraction).toBeCloseTo(0.5, 1);
    const out = await vanAt((c) => (c[2] as number) + 500, "circle", "namaka");
    expect(out.van).toMatchObject({ legIndex: 2 });
  });

  it("on the way out (Riva → Circle) the leg is unchanged", async () => {
    const { van } = await vanAt((c) => (c[1] as number) + 500, "riva", "circle");
    expect(van).toMatchObject({ legIndex: 1 });
  });
});
