/** Typed errors. Services throw them; each adapter maps them once (HTTP status, bot reply, MCP error). */
import type { z } from "zod";

export type ServiceErrorCode =
  | "INVALID"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STALE_VERSION"
  | "GONE"
  | "RATE_LIMITED";

const STATUS: Record<ServiceErrorCode, number> = {
  INVALID: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_VERSION: 409,
  GONE: 410,
  RATE_LIMITED: 429,
};

export class ServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export const isServiceError = (e: unknown): e is ServiceError => e instanceof ServiceError;

export const httpStatus = (e: unknown): number => (isServiceError(e) ? STATUS[e.code] : 500);

/** Safe text for people; unexpected errors get a generic one (adapters log the real error). */
export const userMessage = (e: unknown): string => (isServiceError(e) ? e.message : "Something went wrong. Try again.");

/** Validate a service input; a zod failure becomes INVALID with the issues in details. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw new ServiceError("INVALID", first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input.", {
    issues: r.error.issues,
  });
}
