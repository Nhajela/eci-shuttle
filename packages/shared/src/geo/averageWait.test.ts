import { describe, it } from "vitest";

describe("averageWait", () => {
  it.todo("equal headways of 20 min → 10 min");
  it.todo("10 and 30 min headways → 12.5 min (longer than half the 20 min mean)");
  it.todo("empty → null");
  it.todo("zero, negative and NaN headways are ignored");
  it.todo("single headway H → H / 2");
});
