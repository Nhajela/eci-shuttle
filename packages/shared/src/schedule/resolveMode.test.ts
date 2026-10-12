import { describe, it } from "vitest";

describe("resolveMode", () => {
  it.todo("null config → unpaired, intervalS null");
  it.todo("revoked → revoked even if also killed");
  it.todo("killed → killed regardless of windows");
  it.todo("no windows → idle with idleHeartbeatS, until null");
  it.todo("inside an active window → active with activeIntervalS, until = window end");
  it.todo("active window with its own intervalS uses it");
  it.todo("overlapping active windows → smallest intervalS, until = end of merged run");
  it.todo("adjacent active windows (end == next start) merge for `until`");
  it.todo("silence window overlapping an active window → idle until silence end");
  it.todo("silence starting inside an active window cuts `until` to the silence start");
  it.todo("before the first window → idle, until = next active start, next = that window");
  it.todo("half-open: now == endsAt is outside, now == startsAt is inside");
  it.todo("unsorted windows give the same answer as sorted ones");
  it.todo("schedule exhausted (phone offline past the 48h horizon) → idle, until null");
});
