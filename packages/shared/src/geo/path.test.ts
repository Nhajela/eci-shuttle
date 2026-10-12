import { describe, it } from "vitest";

describe("distanceM", () => {
  it.todo("same point → 0");
  it.todo("Riva to Circle is about the known road-free distance (within 1%)");
});

describe("pathLengthM", () => {
  it.todo("sum of segment lengths; one point → 0");
});

describe("projectOntoPath", () => {
  it.todo("point on the path → offsetM ≈ 0, alongM = distance from start");
  it.todo("point beside a segment → perpendicular foot, offsetM = perpendicular distance");
  it.todo("point before the start clamps to alongM 0");
  it.todo("point past the end clamps to alongM = totalM");
  it.todo("picks the nearest segment, ties go to the earlier segment (loop paths)");
  it.todo("repeated points (zero-length segments) don't divide by zero");
  it.todo("single-point path → alongM 0, totalM 0");
  it.todo("empty path throws");
});
