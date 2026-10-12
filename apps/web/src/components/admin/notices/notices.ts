/** admin-notices: pure helpers for the Notices page (labels, IST inputs, display order, per-page preview). */
import {
  formatIst,
  type HHMM,
  type IsoDate,
  istDate,
  istHHMM,
  istToEpoch,
  type NoticeChannel,
  type NoticePlacement,
  type NoticeSeverity,
  SEVERITY_RANK,
} from "@eci-shuttle/shared";
import type { Notice } from "@/db/types";

export type Shown = Pick<
  Notice,
  "id" | "text" | "severity" | "pinned" | "sort" | "startsAt" | "createdAt" | "endsAt" | "endedAt" | "placements"
>;

export const SEVERITIES: { value: NoticeSeverity; label: string }[] = [
  { value: "info", label: "Info" },
  { value: "heads_up", label: "Heads-up" },
  { value: "urgent", label: "Urgent" },
];

/** Card colour per severity: the same classes as the public page uses for its notice strip. */
export const SEVERITY_CLASS: Record<NoticeSeverity, string> = {
  info: "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-50",
  heads_up: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50",
  urgent: "border-red-400 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-50",
};

export const CHANNELS: { value: NoticeChannel; label: string; hint: string }[] = [
  { value: "subscribers", label: "Telegram subscribers", hint: "People following the placed spots (or all notices)" },
  { value: "group", label: "Post in the group", hint: "The main Telegram group" },
  { value: "group_pin", label: "Post and pin in the group", hint: "Unpinned automatically when it ends" },
];

/** "2026-10-12T09:40" (a datetime-local value, read as IST) → ISO; "" → null. */
export function istInputToIso(v: string): string | null {
  if (!v) return null;
  const [date, time] = v.split("T");
  return new Date(istToEpoch(date as IsoDate, time.slice(0, 5) as HHMM)).toISOString();
}

/** A Date → the datetime-local value for its IST wall clock; null → "". */
export const isoToIstInput = (d: Date | null): string => (d ? `${istDate(d)}T${istHHMM(d)}` : "");

export function noticeState(n: Pick<Shown, "startsAt" | "endsAt" | "endedAt">, now: number) {
  if ((n.endedAt && +n.endedAt <= now) || (n.endsAt && +n.endsAt <= now)) return "over" as const;
  return +n.startsAt > now ? ("upcoming" as const) : ("showing" as const);
}

export function placementLabel(p: string, names: Record<string, string>): string {
  if (p === "everywhere") return "Everywhere";
  if (p === "schedule") return "Above the schedule";
  if (p === "admin") return "Admin home";
  const [kind, id] = p.split(":");
  if (kind === "spot") return names[id] ? `At ${names[id]}` : "At a removed spot";
  return names[id] ?? "A service not on the schedule";
}

/** The list's "Until" cell. No endsAt and not ended means it is still showing until someone ends it. */
export function untilLabel(n: Pick<Notice, "endsAt" | "endedAt">): string {
  if (n.endedAt && (!n.endsAt || n.endedAt < n.endsAt)) return `${formatIst(n.endedAt)} (ended by hand)`;
  return n.endsAt ? formatIst(n.endsAt) : "Until ended by hand";
}

/**
 * Display order (SPEC §6b), the same as svc-notices' activeNotices: pinned first by sort, then severity (urgent
 * first), then newest. ponytail: mirrors services/notices compareNotices, which client code can't import (it pulls
 * in the DB); move both to @eci-shuttle/shared if the order ever changes.
 */
export function compareNotices(a: Shown, b: Shown): number {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    (a.pinned ? a.sort - b.sort : 0) ||
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    +b.startsAt - +a.startsAt ||
    +b.createdAt - +a.createdAt
  );
}

export type Draft = {
  text: string;
  severity: NoticeSeverity;
  pinned: boolean;
  sort: number;
  /** ISO or null = now */
  startsAt: string | null;
  placements: NoticePlacement[];
};

export type PreviewPage = {
  placement: NoticePlacement;
  label: string;
  items: { id: string; text: string; severity: NoticeSeverity; pinned: boolean; isDraft: boolean }[];
};

/**
 * What each page the draft is placed on will show when it starts: the draft among the other notices showing
 * there at that moment, in display order.
 */
export function previewPages(draft: Draft, others: Shown[], names: Record<string, string>, now: number): PreviewPage[] {
  const at = Math.max(now, draft.startsAt ? Date.parse(draft.startsAt) : now);
  const d: Shown = {
    ...draft,
    id: "draft",
    startsAt: new Date(at),
    createdAt: new Date(now),
    endsAt: null,
    endedAt: null,
  };
  return [...new Set(draft.placements)].map((placement) => ({
    placement,
    label: placementLabel(placement, names),
    items: [d, ...others.filter((o) => o.placements.includes(placement) && noticeState(o, at) === "showing")]
      .sort(compareNotices)
      .map((s) => ({ id: s.id, text: s.text, severity: s.severity, pinned: s.pinned, isDraft: s === d })),
  }));
}
