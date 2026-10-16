/**
 * The gift wrap: one short, warm line beside the plain answer. Pure text; the answer itself (answerParts) stays
 * unchanged. Never lateness: no "late", "delay", "behind" (SPEC §6a.2).
 */
import type { AnswerLine } from "@eci-shuttle/shared";

export type Mood = { emoji: string; text: string };

/** status.ts ON_BREAK */
const ON_BREAK = "on a short break";
const STALE_S = 120;

export type DayPart = "night" | "morning" | "day" | "evening";

/** From an IST hour (0–23). */
export function dayPart(hour: number): DayPart {
  if (hour < 5 || hour >= 21) return "night";
  if (hour < 10) return "morning";
  if (hour < 17) return "day";
  return "evening";
}

/**
 * `ageS` = how old the answer is (added to last seen, like answerParts); `hour` = IST hour now.
 * A live line older than 2 min reads as a timetable line, so the whimsy never outruns the facts.
 */
export function mood(line: AnswerLine, ageS: number, hour: number): Mood {
  const part = dayPart(hour);
  const stale = line.kind === "live" && line.lastSeenS !== null && line.lastSeenS + ageS > STALE_S;
  if (line.kind === "live" && !stale) {
    if (line.minutes === null) return { emoji: "🛣️", text: "Taking the scenic route. It's out there." };
    if (line.minutes === 0) return { emoji: "🚐", text: "Shuttle's here! Hop on." };
    if (line.minutes <= 2) return { emoji: "👀", text: "Almost there. Grab your things." };
    if (line.minutes <= 6) return { emoji: "🌴", text: "Rolling your way." };
    return { emoji: "☕", text: "Time for a quick chai." };
  }
  if (line.kind === "live" || line.kind === "timetable") {
    if (line.phaseText === ON_BREAK) return { emoji: "☕", text: "Driver's on a chai break. Back soon." };
    if (line.phaseText === "first shuttle today")
      return { emoji: part === "night" ? "🌙" : "☀️", text: "Still waking up. First shuttle is on the way." };
    if (line.nextAtLabel) return { emoji: "🗓️", text: "Running on the timetable for now." };
    return { emoji: "🚐", text: "Out doing its loop. Running on the timetable for now." };
  }
  return part === "night" || part === "evening"
    ? { emoji: "🌙", text: "The shuttle's tucked in for the night." }
    : { emoji: "🌴", text: "Done for today. Enjoy the beach." };
}

/** No public shuttle at all today, or none at this stop. */
export function noShuttleMood(hour: number): Mood {
  return dayPart(hour) === "night"
    ? { emoji: "🌙", text: "The shuttle's tucked in for the night." }
    : { emoji: "🏖️", text: "Day off for the shuttle. Beach day for you?" };
}
