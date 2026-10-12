import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/services/kernel/errors";

const actor = { kind: "admin", id: "p1", workspaceId: "ws1", role: "ops", channel: "web" };
const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  acceptSuggestion: vi.fn(),
  dismissSuggestion: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/db", () => ({ db: () => "DB" }));
vi.mock("@/services/learning/insights", () => ({
  acceptSuggestion: m.acceptSuggestion,
  dismissSuggestion: m.dismissSuggestion,
}));
vi.mock("@/services/mcp/proposals", () => ({ confirm: m.confirm }));

const { acceptSuggestionAction, confirmProposalAction, dismissSuggestionAction } = await import("./actions");

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  m.requireAdmin.mockResolvedValue({ actor, workspace: { id: "ws1", slug: "test" } });
});

describe("acceptSuggestionAction", () => {
  it("needs ops in the form's workspace and returns the proposal to confirm", async () => {
    m.acceptSuggestion.mockResolvedValue({ suggestion: {}, proposalCode: "P-ABC", summary: "Shift the 09:40" });
    const r = await acceptSuggestionAction(null, form({ w: "test", suggestionId: "s1" }));
    expect(m.requireAdmin).toHaveBeenCalledWith({ w: "test", minRole: "ops" });
    expect(m.acceptSuggestion).toHaveBeenCalledWith("DB", actor, { workspaceId: "ws1", suggestionId: "s1" });
    expect(r).toEqual({ ok: true, proposalCode: "P-ABC", summary: "Shift the 09:40" });
  });

  it("turns service errors into a plain message", async () => {
    m.acceptSuggestion.mockRejectedValue(new ServiceError("CONFLICT", "Already accepted."));
    expect(await acceptSuggestionAction(null, form({ suggestionId: "s1" }))).toEqual({
      ok: false,
      error: "Already accepted.",
    });
    expect(m.requireAdmin).toHaveBeenCalledWith({ w: null, minRole: "ops" });
  });

  it("hides unexpected errors", async () => {
    m.acceptSuggestion.mockRejectedValue(new Error("db exploded"));
    expect(await acceptSuggestionAction(null, form({ suggestionId: "s1" }))).toEqual({
      ok: false,
      error: "Something went wrong. Try again.",
    });
  });
});

describe("dismissSuggestionAction", () => {
  it("dismisses in the actor's workspace", async () => {
    m.dismissSuggestion.mockResolvedValue({});
    expect(await dismissSuggestionAction(null, form({ w: "test", suggestionId: "s2" }))).toEqual({ ok: true });
    expect(m.dismissSuggestion).toHaveBeenCalledWith("DB", actor, { workspaceId: "ws1", suggestionId: "s2" });
  });
});

describe("confirmProposalAction", () => {
  it("confirms the proposal code with now", async () => {
    m.confirm.mockResolvedValue({ proposalId: "P-ABC", summary: "Shift the 09:40", results: [] });
    const r = await confirmProposalAction(null, form({ w: "test", code: "P-ABC" }));
    expect(r).toEqual({ ok: true, summary: "Shift the 09:40" });
    const [db, a, input, now] = m.confirm.mock.calls[0] ?? [];
    expect([db, a, input]).toEqual(["DB", actor, { code: "P-ABC" }]);
    expect(now).toBeInstanceOf(Date);
  });

  it("explains an expired proposal", async () => {
    m.confirm.mockRejectedValue(new ServiceError("GONE", "That proposal expired."));
    expect(await confirmProposalAction(null, form({ code: "P-OLD" }))).toEqual({
      ok: false,
      error: "That proposal expired.",
    });
  });
});
