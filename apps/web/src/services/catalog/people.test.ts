import { describe, expect, it } from "vitest";
import { inQuietHours } from "./people";

// 2026-10-12 is in IST (UTC+5:30): 22:30 IST = 17:00Z
const ist = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 9, 12, h, m) - 330 * 60_000);
};

describe("inQuietHours", () => {
  it("is never quiet without quiet hours", () => {
    expect(inQuietHours({ quietFrom: null, quietTo: null }, ist("03:00"))).toBe(false);
  });

  it("same-day window, in IST, end exclusive", () => {
    const p = { quietFrom: "13:00", quietTo: "15:00" };
    expect(inQuietHours(p, ist("12:59"))).toBe(false);
    expect(inQuietHours(p, ist("13:00"))).toBe(true);
    expect(inQuietHours(p, ist("14:30"))).toBe(true);
    expect(inQuietHours(p, ist("15:00"))).toBe(false);
  });

  it("window across midnight", () => {
    const p = { quietFrom: "22:30", quietTo: "07:00" };
    expect(inQuietHours(p, ist("22:29"))).toBe(false);
    expect(inQuietHours(p, ist("23:59"))).toBe(true);
    expect(inQuietHours(p, ist("00:00"))).toBe(true);
    expect(inQuietHours(p, ist("06:59"))).toBe(true);
    expect(inQuietHours(p, ist("07:00"))).toBe(false);
    expect(inQuietHours(p, ist("12:00"))).toBe(false);
  });
});
