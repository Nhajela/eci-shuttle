import { describe, it } from "vitest";

describe("geofenceStep", () => {
  it.todo("first fix inside a spot makes it the candidate, no event");
  it.todo("still inside 20 s later → arrived, at = candidateSince");
  it.todo("inside for 19 s then out → no arrival, candidate cleared");
  it.todo("fix with accuracy > 100 m is ignored entirely (lastFixAt unchanged)");
  it.todo("accuracy exactly 100 m is used");
  it.todo("duplicate or older fix is ignored");
  it.todo("inside: drifting between radius and 1.5× radius does not depart (hysteresis)");
  it.todo("inside: first fix beyond 1.5× radius → departed at fix.at");
  it.todo("depart one spot and become candidate for another in one step");
  it.todo("overlapping spots → nearest centre wins");
  it.todo("inside a spot that was archived (not in spots) → departed");
  it.todo("GPS gap: a fix 10 min later still inside keeps the vehicle inside without a new arrival");
});
