import { describe, expect, it } from "vitest";
import type { Service } from "@/db/types";
import { serviceDaysInPlay } from "./service-days";

const at = (hhmm: string, date: string) => new Date(`${date}T${hhmm}:00+05:30`).getTime();
const svc = (over: Partial<Service> = {}) =>
  ({
    id: "s1",
    startTime: "08:00",
    endTime: "22:00",
    validFrom: "2026-10-01",
    validTo: "2026-11-01",
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    ...over,
  }) as Service;

describe("serviceDaysInPlay", () => {
  it("a normal service runs today only", () => {
    const d = serviceDaysInPlay([svc()], [], at("09:30", "2026-10-12"));
    expect(d.map((x) => x.day)).toEqual(["2026-10-12"]);
  });
  it("a cross-midnight service is still on yesterday's day after midnight, until its window ends", () => {
    const night = svc({ startTime: "20:00", endTime: "02:00" });
    expect(serviceDaysInPlay([night], [], at("01:00", "2026-10-13")).map((x) => x.day)).toEqual([
      "2026-10-12",
      "2026-10-13",
    ]);
    expect(serviceDaysInPlay([night], [], at("02:30", "2026-10-13")).map((x) => x.day)).toEqual(["2026-10-13"]);
  });
  it("respects validity and weekdays of each day separately", () => {
    // 2026-10-12 is a Monday (1); the service runs Mondays only
    const night = svc({ startTime: "20:00", endTime: "02:00", daysOfWeek: [1] });
    expect(serviceDaysInPlay([night], [], at("01:00", "2026-10-13")).map((x) => x.day)).toEqual(["2026-10-12"]);
    const ended = svc({ validTo: "2026-10-05" });
    expect(serviceDaysInPlay([ended], [], at("09:30", "2026-10-12"))).toEqual([]);
  });
  it("a cancel_day removes that day only", () => {
    const night = svc({ startTime: "20:00", endTime: "02:00" });
    const cancel = [{ serviceId: "s1", date: "2026-10-12", type: "cancel_day" as const }];
    expect(serviceDaysInPlay([night], cancel, at("01:00", "2026-10-13")).map((x) => x.day)).toEqual(["2026-10-13"]);
    expect(serviceDaysInPlay([svc()], cancel, at("09:30", "2026-10-12"))).toEqual([]);
  });
  it("ignores other exception kinds and other services' cancellations", () => {
    const ex = [
      { serviceId: "s1", date: "2026-10-12", type: "add_departure" as const },
      { serviceId: "other", date: "2026-10-12", type: "cancel_day" as const },
    ];
    expect(serviceDaysInPlay([svc()], ex, at("09:30", "2026-10-12"))).toHaveLength(1);
  });
});
