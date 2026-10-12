import { describe, expect, it } from "vitest";
import {
  compareNotices,
  isoToIstInput,
  istInputToIso,
  noticeState,
  placementLabel,
  previewPages,
  type Shown,
  untilLabel,
} from "./notices";

const T = Date.parse("2026-10-12T04:10:00Z"); // 09:40 IST
const SPOT = "11111111-1111-4111-8111-111111111111";
const SVC = "22222222-2222-4222-8222-222222222222";
const names = { [SPOT]: "Riva", [SVC]: "Party shuttle" };

let n = 0;
function shown(p: Partial<Shown> = {}): Shown {
  n++;
  return {
    id: `id-${n}`,
    text: `notice ${n}`,
    severity: "info",
    pinned: false,
    sort: 0,
    startsAt: new Date(T - 60_000),
    createdAt: new Date(T - 60_000),
    endsAt: null,
    endedAt: null,
    placements: ["everywhere"],
    ...p,
  };
}

describe("IST datetime inputs", () => {
  it("reads a datetime-local value as IST", () => {
    expect(istInputToIso("2026-10-12T09:40")).toBe("2026-10-12T04:10:00.000Z");
  });
  it("empty means null", () => {
    expect(istInputToIso("")).toBeNull();
  });
  it("round-trips to the input format in IST", () => {
    expect(isoToIstInput(new Date(T))).toBe("2026-10-12T09:40");
    expect(isoToIstInput(null)).toBe("");
  });
});

describe("noticeState", () => {
  it("upcoming before start, showing while on, over after end or ended by hand", () => {
    expect(noticeState(shown({ startsAt: new Date(T + 1) }), T)).toBe("upcoming");
    expect(noticeState(shown(), T)).toBe("showing");
    expect(noticeState(shown({ endsAt: new Date(T) }), T)).toBe("over");
    expect(noticeState(shown({ endedAt: new Date(T - 1) }), T)).toBe("over");
  });
});

describe("placementLabel", () => {
  it("names each placement", () => {
    expect(placementLabel("everywhere", names)).toBe("Everywhere");
    expect(placementLabel("schedule", names)).toBe("Above the schedule");
    expect(placementLabel("admin", names)).toBe("Admin home");
    expect(placementLabel(`spot:${SPOT}`, names)).toBe("At Riva");
    expect(placementLabel(`service:${SVC}`, names)).toBe("Party shuttle");
    expect(placementLabel(`spot:${SVC.replace("2", "3")}`, names)).toBe("At a removed spot");
    expect(placementLabel(`service:${SPOT.replace("1", "3")}`, names)).toBe("A service not on the schedule");
  });
});

describe("untilLabel", () => {
  it("open-ended and not ended: still live until someone ends it", () => {
    expect(untilLabel({ endsAt: null, endedAt: null })).toBe("Until ended by hand");
  });
  it("ended by hand shows when", () => {
    expect(untilLabel({ endsAt: null, endedAt: new Date(T) })).toBe("Mon 12 Oct, 09:40 (ended by hand)");
  });
  it("ended by hand before its end time shows when it was ended", () => {
    expect(untilLabel({ endsAt: new Date(T + 3_600_000), endedAt: new Date(T) })).toBe(
      "Mon 12 Oct, 09:40 (ended by hand)",
    );
  });
  it("endsAt set shows the end time", () => {
    expect(untilLabel({ endsAt: new Date(T), endedAt: null })).toBe("Mon 12 Oct, 09:40");
  });
});

describe("compareNotices", () => {
  it("pinned by sort first, then urgent first, then newest", () => {
    const pinned2 = shown({ pinned: true, sort: 2 });
    const pinned1 = shown({ pinned: true, sort: 1, severity: "info" });
    const urgent = shown({ severity: "urgent" });
    const oldInfo = shown({ startsAt: new Date(T - 600_000) });
    const newInfo = shown({ startsAt: new Date(T - 1_000) });
    const sorted = [oldInfo, urgent, pinned2, newInfo, pinned1].sort(compareNotices);
    expect(sorted.map((s) => s.id)).toEqual([pinned1.id, pinned2.id, urgent.id, newInfo.id, oldInfo.id]);
  });
});

describe("previewPages", () => {
  const draft = {
    text: "Pickup at the side gate",
    severity: "heads_up" as const,
    pinned: false,
    sort: 0,
    startsAt: null,
    placements: ["everywhere", `spot:${SPOT}`] as Shown["placements"],
  };

  it("one page per placement of the draft, the draft among what already shows there, in display order", () => {
    const urgentHere = shown({ severity: "urgent", placements: [`spot:${SPOT}`] });
    const infoEverywhere = shown({ placements: ["everywhere"] });
    const elsewhere = shown({ placements: ["schedule"] });
    const over = shown({ placements: [`spot:${SPOT}`], endedAt: new Date(T - 1) });
    const pages = previewPages(draft, [urgentHere, infoEverywhere, elsewhere, over], names, T);

    expect(pages.map((p) => p.label)).toEqual(["Everywhere", "At Riva"]);
    expect(pages[0].items.map((i) => i.id)).toEqual(["draft", infoEverywhere.id]);
    expect(pages[1].items.map((i) => i.id)).toEqual([urgentHere.id, "draft"]);
    expect(pages[1].items[1]).toMatchObject({ text: draft.text, severity: "heads_up", isDraft: true });
  });

  it("previews a future start against what will be showing then", () => {
    const later = new Date(T + 3_600_000).toISOString();
    const endsSoon = shown({ endsAt: new Date(T + 60_000) });
    const pages = previewPages({ ...draft, placements: ["everywhere"], startsAt: later }, [endsSoon], names, T);
    expect(pages[0].items.map((i) => i.id)).toEqual(["draft"]);
  });

  it("skips duplicate placements and blank text still previews", () => {
    const pages = previewPages({ ...draft, text: "", placements: ["admin", "admin"] }, [], names, T);
    expect(pages).toHaveLength(1);
    expect(pages[0].items[0].text).toBe("");
  });
});
