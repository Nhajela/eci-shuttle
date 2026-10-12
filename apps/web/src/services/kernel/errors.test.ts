import { describe, expect, it } from "vitest";
import { z } from "zod";
import { httpStatus, isServiceError, parseInput, ServiceError, userMessage } from "./errors";

describe("ServiceError", () => {
  it("carries a code, message and details", () => {
    const e = new ServiceError("NOT_FOUND", "No such spot.", { entity: "spot" });
    expect(e).toBeInstanceOf(Error);
    expect(isServiceError(e)).toBe(true);
    expect(e).toMatchObject({ code: "NOT_FOUND", message: "No such spot.", details: { entity: "spot" } });
  });

  it("maps codes to HTTP statuses", () => {
    expect(httpStatus(new ServiceError("INVALID", "x"))).toBe(400);
    expect(httpStatus(new ServiceError("UNAUTHENTICATED", "x"))).toBe(401);
    expect(httpStatus(new ServiceError("FORBIDDEN", "x"))).toBe(403);
    expect(httpStatus(new ServiceError("NOT_FOUND", "x"))).toBe(404);
    expect(httpStatus(new ServiceError("CONFLICT", "x"))).toBe(409);
    expect(httpStatus(new ServiceError("STALE_VERSION", "x"))).toBe(409);
    expect(httpStatus(new ServiceError("GONE", "x"))).toBe(410);
    expect(httpStatus(new ServiceError("RATE_LIMITED", "x"))).toBe(429);
    expect(httpStatus(new Error("boom"))).toBe(500);
  });

  it("gives users a safe message", () => {
    expect(userMessage(new ServiceError("CONFLICT", "Already assigned."))).toBe("Already assigned.");
    expect(userMessage(new Error("db password is hunter2"))).toBe("Something went wrong. Try again.");
  });
});

describe("parseInput", () => {
  const S = z.object({ name: z.string().min(1), radiusM: z.number().default(75) });

  it("returns the parsed value with defaults", () => {
    expect(parseInput(S, { name: "Riva" })).toEqual({ name: "Riva", radiusM: 75 });
  });

  it("throws INVALID with the issues", () => {
    try {
      parseInput(S, { name: "" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).code).toBe("INVALID");
      expect((e as ServiceError).details?.issues).toEqual([expect.objectContaining({ path: ["name"] })]);
    }
  });
});
