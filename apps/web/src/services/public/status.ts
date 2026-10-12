/**
 * svc-public: the attendee answer (SPEC §6, §6a.2–4). No login; no actor. Shared by /api/status, the public
 * page, the bot's /shuttle and arrival alerts, and MCP shuttle_public_answer.
 * Never exposes lateness: no "late", no planned-vs-expected.
 */
import { type AnswerLine, notImplemented, type PublicStatus } from "@eci-shuttle/shared";
import type { Db } from "@/db";

/**
 * The whole public status of a workspace at `now`. Spots = those on a public service running today, in route
 * order. Per spot, one AnswerLine per public service serving it:
 * - live: a vehicle on that service with a ping ≤ 2 min old → etaToSpot minutes, p20–p80 range, approx when
 *   basis is "estimate", phaseText ("leaving Circle now", "at Riva", "on the way"), lastSeenS.
 * - timetable: no live data → next planned departure from that spot today (learned typical time for the
 *   slot when known), phaseText "live tracking off".
 * - none: nothing more today ("no more shuttles today").
 * Notices: everywhere / spot / service / schedule placements active at now (notices.activeNotices), pinned first
 * by sort, then urgent first, then newest. Schedule rows: today's departures from the spot, past/next flags;
 * loop services as "about every N min" from the measured cycle.
 */
export async function publicStatus(db: Db, workspaceId: string, now: Date): Promise<PublicStatus> {
  return notImplemented(db, workspaceId, now);
}

/** The answer lines for one spot (bot /shuttle, arrival alerts). Same rules as publicStatus. */
export async function spotAnswer(db: Db, workspaceId: string, spotId: string, now: Date): Promise<AnswerLine[]> {
  return notImplemented(db, workspaceId, spotId, now);
}
