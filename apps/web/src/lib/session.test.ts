import { expect, it } from "vitest";
import { safeNext } from "./session";

it("safeNext keeps same-site paths and refuses open redirects", () => {
  expect(safeNext("/admin/live?w=test")).toBe("/admin/live?w=test");
  for (const bad of [null, undefined, "", "https://evil.com", "//evil.com", "/\\evil.com", "/\t/evil.com", "admin"])
    expect(safeNext(bad)).toBe("/admin");
});
