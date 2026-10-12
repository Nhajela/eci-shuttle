/**
 * Pure text for the public page (SPEC §6). Only predicted arrival, timetable time or "nothing more":
 * never lateness, never planned-vs-expected (§6a.2).
 */
import type { AnswerLine } from "@eci-shuttle/shared";

/** `small`: not a time, so it is shown in the small style. */
export type AnswerParts = { label: string; value: string; range: string | null; small?: true };

/** Past this, a live answer is no longer live (SPEC §6.2). */
const STALE_S = 120;

const isStale = (line: AnswerLine, ageS: number) =>
  line.kind === "live" && line.lastSeenS !== null && line.lastSeenS + ageS > STALE_S;

/**
 * The big line. `single` = the only service at this spot, so it reads as a sentence.
 * `ageS` = how old the answer is; a live line older than 2 min falls back to the timetable.
 */
export function answerParts(line: AnswerLine, single: boolean, ageS = 0): AnswerParts {
  const label = single ? null : line.serviceName;
  if (isStale(line, ageS))
    return line.nextAtLabel
      ? { label: label ?? "Next scheduled", value: line.nextAtLabel, range: null }
      : { label: label ?? "Shuttle", value: "Live tracking off", range: null, small: true };
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
  return `${isStale(line, ageS) ? "live tracking off" : line.phaseText} · last seen ${s < 60 ? `${s}s` : `${Math.round(s / 60)} min`} ago`;
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
