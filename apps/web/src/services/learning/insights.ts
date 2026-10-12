/** learning: admin Insights and MCP shuttle_insights / shuttle_suggestions (SPEC §6a.5–6). viewer+ reads. */
import { type IsoDate, notImplemented } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { LearningExclusion, Suggestion } from "@/db/types";
import type { Actor } from "../kernel";

export type Insights = {
  /** % of departures within 3 min, per spot */
  onTime: { spotId: string; pct: number; n: number }[];
  /** heatmap: departure slot "HH:MM" × IST weekday → average and p80 delay */
  delayBySlot: { spotId: string; slot: string; weekday: number; avgMin: number; p80Min: number; n: number }[];
  dwellBySpotHour: { spotId: string; hour: number; medianS: number; n: number }[];
  legByHour: { fromSpotId: string; toSpotId: string; hour: number; medianS: number; n: number }[];
  loopCycleS: { routeId: string; medianS: number; n: number }[];
  /** % of service windows that had live tracking */
  trackedPct: number;
  /** E[H²]/2E[H] per spot, seconds */
  averageWaitS: { spotId: string; seconds: number | null }[];
};

export async function getInsights(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; from: IsoDate; to: IsoDate },
): Promise<Insights> {
  return notImplemented(db, actor, input);
}

/** viewer+. Open first. */
export async function listSuggestions(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; status?: Suggestion["status"] },
): Promise<Suggestion[]> {
  return notImplemented(db, actor, input);
}

/**
 * ops+. Accepting turns the suggestion's proposedChanges into a normal MCP proposal (mcp/proposals.propose) and
 * stores its id; the timetable only changes when someone confirms it. Audited suggestion.accept.
 */
export async function acceptSuggestion(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; suggestionId: string },
): Promise<{ suggestion: Suggestion; proposalCode: string; summary: string }> {
  return notImplemented(db, actor, input);
}

/** ops+. Audited suggestion.dismiss. */
export async function dismissSuggestion(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; suggestionId: string },
): Promise<Suggestion> {
  return notImplemented(db, actor, input);
}

export const ExcludeDayInput = z.object({
  workspaceId: z.uuid(),
  date: z.iso.date(),
  serviceId: z.uuid().nullable().default(null),
  reason: z.string().max(500).nullable().default(null),
});
/** ops+. "Don't learn from this day" (road closure). Audited learning.exclude. */
export async function excludeDay(
  db: Db,
  actor: Actor,
  input: z.input<typeof ExcludeDayInput>,
): Promise<LearningExclusion> {
  return notImplemented(db, actor, input);
}
