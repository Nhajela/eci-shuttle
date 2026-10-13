import { describe, expect, it } from "vitest";
import { waitingView } from "./waiting";

describe("waitingView", () => {
  it("labels each person with where to and since when (IST), with how long", () => {
    const now = Date.parse("2026-10-13T06:24:30Z"); // 11:54:30 IST
    const out = waitingView(
      [
        {
          spotId: "riva",
          spotName: "Riva",
          count: 2,
          people: [
            { requestId: "a", name: "Asha (@asha)", toSpotName: "Circle", since: new Date("2026-10-13T06:12:00Z") },
            { requestId: "b", name: "Ben", toSpotName: "Nanu", since: new Date("2026-10-13T06:24:00Z") },
          ],
        },
      ],
      now,
    );
    expect(out).toEqual([
      {
        spotId: "riva",
        spotName: "Riva",
        count: 2,
        people: [
          { id: "a", name: "Asha (@asha)", to: "Circle", since: "since 11:42 (12 min)" },
          { id: "b", name: "Ben", to: "Nanu", since: "since 11:54 (just now)" },
        ],
      },
    ]);
  });
});
