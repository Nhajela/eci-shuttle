/**
 * web-mcp: tool results and the one error mapping every tool handler goes through (as eci-events-mcp):
 * ServiceErrors become "<CODE>: message. hint" a model can act on, anything else a stable INTERNAL_ERROR, and each
 * call logs one JSON line (tool, person, ms, outcome; never arguments).
 */
import { isServiceError } from "@/services/kernel";
import { ERROR_HINTS, INTERNAL_ERROR } from "./text";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export const ok = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structured ? { structuredContent: structured } : {}),
});

export const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** A refusal written for the model, with its code first (e.g. UNKNOWN_WORKSPACE text). */
export class ToolError extends Error {}

export function errorText(err: unknown): string | null {
  if (err instanceof ToolError) return err.message;
  if (isServiceError(err)) return [`${err.code}: ${err.message}`, ERROR_HINTS[err.code]].filter(Boolean).join(" ");
  return null;
}

export function withToolHandler<P>(
  tool: string,
  personId: string,
  fn: (p: P) => Promise<ToolResult>,
): (p: P) => Promise<ToolResult> {
  return async (p: P) => {
    const start = Date.now();
    const log = (status: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ scope: "mcp", tool, person: personId, ms: Date.now() - start, status, ...extra }));
    try {
      const r = await fn(p);
      log("ok");
      return r;
    } catch (err) {
      const text = errorText(err);
      if (text) {
        log("refused", { code: text.split(":")[0] });
        return fail(text);
      }
      log("internal_error", { message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
      return fail(INTERNAL_ERROR);
    }
  };
}
