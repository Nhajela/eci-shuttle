import { describe, it } from "vitest";

describe("trackingWindows", () => {
  it.todo("one service 08:00–20:00, one vehicle assigned all day → 07:45–20:15");
  it.todo("custom padMin 0 → exact service window");
  it.todo("assignment shorter than the window clips it (vehicle moved to a party service)");
  it.todo("service with no assigned vehicle → nothing");
  it.todo("cancel_day → no window that day");
  it.todo("non-running weekday → no window");
  it.todo("cross-midnight 22:00–02:00 → 21:45–02:15 spanning two dates");
  it.todo("a service day that started yesterday still contributes after midnight");
  it.todo("add_departure outside the window widens that day's window");
  it.todo("two services on one vehicle that overlap after padding merge into one window with both serviceIds");
  it.todo("touching windows (end == start) merge");
  it.todo("clipped to [from, to)");
  it.todo("48h horizon spanning three service days");
  it.todo("sorted by vehicleId then startsAt");
});
