import { describe, it } from "vitest";

describe("etaToSpot", () => {
  it.todo("halfway along the only leg → half the leg median");
  it.todo("segment speeds override the proportional estimate where they cover the remaining path");
  it.todo("at the target spot → 0 min, legsChained 0");
  it.todo("at another spot → remaining dwell + following legs");
  it.todo("remaining dwell never goes negative after overstaying");
  it.todo("chains legs and dwells through intermediate spots (Here in 34 min)");
  it.todo("Riva → Circle → Riva: target Riva while on leg 0 → the second occurrence");
  it.todo("loop: past the last spot wraps to leg 0");
  it.todo("not loop and target behind → null");
  it.todo("target not on the route → null");
  it.todo("legIndex out of range → null");
  it.todo("lo ≤ minutes ≤ hi, built from p20 / p80");
  it.todo("any thin estimate → basis estimate; all solid → learned");
});
