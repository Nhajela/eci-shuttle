/**
 * Pure text for the public page (SPEC §6). Only predicted arrival, timetable time or "nothing more":
 * never lateness, never planned-vs-expected (§6a.2).
 */
import type { AnswerLine } from "@eci-shuttle/shared";

export type AnswerParts = { label: string; value: string; range: string | null };

/** The big line. `single` = the only service at this spot, so it reads as a sentence. */
export function answerParts(line: AnswerLine, single: boolean): AnswerParts {
  const label = single ? null : line.serviceName;
  if (line.kind === "live" && line.minutes !== null) {
    if (line.minutes === 0) return { label: label ?? "Shuttle is", value: "here now", range: null };
    const { rangeLo: lo, rangeHi: hi } = line;
    return {
      label: label ?? "Shuttle will be here in",
      value: `${line.approx ? "about " : ""}${line.minutes} min`,
      range: lo !== null && hi !== null && lo !== hi ? `${lo}–${hi}` : null,
    };
  }
  if (line.kind === "timetable" && line.nextAtLabel)
    return { label: label ?? "Next scheduled", value: line.nextAtLabel, range: null };
  return { label: line.serviceName, value: "No more today", range: null };
}

/** The small line under it. `ageS` = how old the answer is (edge cache, failed polls), added to last seen. */
export function contextText(line: AnswerLine, ageS: number): string {
  if (line.lastSeenS === null) return line.phaseText;
  const s = line.lastSeenS + ageS;
  return `${line.phaseText} · last seen ${s < 60 ? `${s}s` : `${Math.round(s / 60)} min`} ago`;
}

export function ageSeconds(generatedAt: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(generatedAt)) / 1000));
}

export function pickSpot(spots: { spotId: string }[], remembered: string | undefined): string | null {
  return spots.find((s) => s.spotId === remembered)?.spotId ?? spots[0]?.spotId ?? null;
}

/** The chosen spot is remembered per device in a cookie, so the server can render the right first answer. */
export function spotCookieName(slug: string | null): string {
  return slug ? `eci_spot_${slug}` : "eci_spot";
}
