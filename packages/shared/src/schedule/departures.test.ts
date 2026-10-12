import { describe, it } from "vitest";

describe("expandServiceDepartures", () => {
  it.todo("every 20 min 08:00–10:00 → 08:00 … 09:40 (end exclusive)");
  it.todo("explicit times are sorted and kept only inside the window");
  it.todo("loop pattern → no departures");
  it.todo("date before validFrom / after validTo → []");
  it.todo("validFrom and validTo are inclusive");
  it.todo("weekday not in daysOfWeek → [] (IST weekday, 1 = Monday)");
  it.todo("cancel_day → []");
  it.todo("cancel_departure removes only that time");
  it.todo("shift_minutes +10 moves 09:40 to 09:50 with planned 09:40, shiftedMin 10");
  it.todo("negative shift moves earlier");
  it.todo("add_departure adds an extra one, even outside the window, flagged added");
  it.todo("exception for another service or another date is ignored");
  it.todo("exception naming a time that is not planned is ignored");
  it.todo("cross-midnight 22:00–02:00 every 60 → 22,23,00,01; after-midnight ones on date+1, service day = date");
  it.todo("`at` is IST: 08:00 IST on 2026-10-12 == 2026-10-12T02:30:00Z");
});
