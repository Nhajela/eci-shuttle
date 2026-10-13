/** admin-live: the "Waiting" section (open /need requests per stop), as plain labels for the client. Pure. */
import { istHHMM } from "@eci-shuttle/shared";
import type { WaitingSpot } from "@/services/subscriptions/need-text";

export type WaitingView = {
  spotId: string;
  spotName: string;
  count: number;
  people: { id: string; name: string; to: string; since: string }[];
};

/** "since 11:42 (12 min)", IST; "since 11:42 (just now)" under a minute. */
export function waitingView(spots: WaitingSpot[], nowMs: number): WaitingView[] {
  return spots.map((s) => ({
    spotId: s.spotId,
    spotName: s.spotName,
    count: s.count,
    people: s.people.map((p) => {
      const min = Math.floor((nowMs - p.since.getTime()) / 60_000);
      return {
        id: p.requestId,
        name: p.name,
        to: p.toSpotName,
        since: `since ${istHHMM(p.since)} (${min < 1 ? "just now" : `${min} min`})`,
      };
    }),
  }));
}
