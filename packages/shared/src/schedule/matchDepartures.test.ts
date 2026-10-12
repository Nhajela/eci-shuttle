import { describe, it } from "vitest";

describe("matchDepartures", () => {
  it.todo("each actual takes the nearest planned within ±25 min");
  it.todo("no actuals → every planned is missed");
  it.todo("actual 26 min after the only planned → planned missed, actual unmatched");
  it.todo("exactly 25 min is inside the tolerance");
  it.todo("greedy in actual time order: a late first run can take a slot a later run was closer to");
  it.todo("tie on distance → earlier planned");
  it.todo("early departure gives negative delay");
  it.todo("two actuals near one planned → the first takes it, the second takes the next or is unmatched");
  it.todo("unsorted inputs give the same result");
  it.todo("custom tolerance");
  it.todo("delayMin rounded to one decimal");
});
