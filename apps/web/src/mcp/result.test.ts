import { describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/services/kernel";
import { ToolError, withToolHandler } from "./result";
import { ERROR_HINTS, INTERNAL_ERROR } from "./text";

vi.spyOn(console, "log").mockImplementation(() => {});
const run = (err: unknown) =>
  withToolHandler("t", "p1", async () => {
    throw err;
  })({});

describe("withToolHandler", () => {
  it("ServiceError → '<CODE>: message' plus the hint, as an error result", async () => {
    const r = await run(new ServiceError("STALE_VERSION", "Spot changed."));
    expect(r).toEqual({
      isError: true,
      content: [{ type: "text", text: `STALE_VERSION: Spot changed. ${ERROR_HINTS.STALE_VERSION}` }],
    });
    expect((await run(new ServiceError("INVALID", "bad"))).content[0].text).toBe("INVALID: bad");
  });

  it("ToolError text as-is; anything else a stable INTERNAL_ERROR without details", async () => {
    expect((await run(new ToolError("NOT_FOUND: nope"))).content[0].text).toBe("NOT_FOUND: nope");
    const r = await run(new Error("db password leaked"));
    expect(r.content[0].text).toBe(INTERNAL_ERROR);
  });
});
