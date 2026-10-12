import { istToEpoch } from "@eci-shuttle/shared";
import { describe, expect, it } from "vitest";
import { quietUntil } from "./prefs";

const at = (hhmm: string, date = "2026-10-12") => istToEpoch(date, hhmm);

describe("quietUntil", () => {
  it("null or equal times are never quiet", () => {
    expect(quietUntil(null, null, at("23:00"))).toBeNull();
    expect(quietUntil("22:00", "22:00", at("22:00"))).toBeNull();
  });

  it("same-day range: held until its end, half-open", () => {
    expect(quietUntil("13:00", "15:00", at("13:00"))).toBe(at("15:00"));
    expect(quietUntil("13:00", "15:00", at("14:59"))).toBe(at("15:00"));
    expect(quietUntil("13:00", "15:00", at("15:00"))).toBeNull();
    expect(quietUntil("13:00", "15:00", at("12:59"))).toBeNull();
  });

  it("across midnight: before midnight ends tomorrow, after midnight ends today", () => {
    expect(quietUntil("22:00", "07:00", at("23:30"))).toBe(at("07:00", "2026-10-13"));
    expect(quietUntil("22:00", "07:00", at("02:30"))).toBe(at("07:00"));
    expect(quietUntil("22:00", "07:00", at("07:00"))).toBeNull();
    expect(quietUntil("22:00", "07:00", at("21:59"))).toBeNull();
  });
});
