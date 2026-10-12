import { describe, expect, it } from "vitest";
import { formatIst, istDate, istHHMM, istToEpoch, istWeekday } from "./ist";

// 2026-10-12T04:10:00Z = 09:40 IST, a Monday
const T = Date.UTC(2026, 9, 12, 4, 10);

describe("IST helpers", () => {
  it("istHHMM / istDate read the IST wall clock", () => {
    expect(istHHMM(T)).toBe("09:40");
    expect(istDate(T)).toBe("2026-10-12");
  });
  it("19:00 UTC is already the next IST day", () => {
    const late = Date.UTC(2026, 9, 12, 19, 0);
    expect(istDate(late)).toBe("2026-10-13");
    expect(istHHMM(late)).toBe("00:30");
  });
  it("istWeekday is ISO (1 = Monday … 7 = Sunday) in IST", () => {
    expect(istWeekday(T)).toBe(1);
    expect(istWeekday(Date.UTC(2026, 9, 11, 19, 0))).toBe(1); // Sun 19:00 UTC = Mon 00:30 IST
    expect(istWeekday(Date.UTC(2026, 9, 11, 12, 0))).toBe(7);
  });
  it("istToEpoch is the inverse of istDate + istHHMM", () => {
    expect(istToEpoch("2026-10-12", "09:40")).toBe(T);
    expect(istToEpoch("2026-10-13", "00:30")).toBe(Date.UTC(2026, 9, 12, 19, 0));
  });
  it("accepts a Date as well as epoch ms", () => {
    expect(istHHMM(new Date(T))).toBe("09:40");
  });
  it("formatIst gives a short human date-time", () => {
    expect(formatIst(T)).toBe("Mon 12 Oct, 09:40");
  });
});
