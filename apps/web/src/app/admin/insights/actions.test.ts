import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/services/kernel/errors";

const actor = { kind: "admin", id: "p1", workspaceId: "ws1", role: "ops", channel: "web" };
const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  acceptSuggestion: vi.fn(),
  dismissSuggestion: vi.fn(),
  confirm: vi.fn(),
  excludeDay: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/db", () => ({ db: () => "DB" }));
vi.mock("@/services/learning/insights", () => ({
  acceptSuggestion: m.acceptSuggestion,
  dismissSuggestion: m.dismissSuggestion,
  excludeDay: m.excludeDay,
}));
vi.mock("@/services/mcp/proposals", () => ({ confirm: m.confirm }));

const { acceptSuggestionAction, confirmProposalAction, dismissSuggestionAction, excludeDayAction } = await import(
  "./actions"
);

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
      code: "CONFLICT",
    });
    expect(m.requireAdmin).toHaveBeenCalledWith({ w: null, minRole: "ops" });
  });

  it("hides unexpected errors", async () => {
    m.acceptSuggestion.mockRejectedValue(new Error("db exploded"));
    expect(await acceptSuggestionAction(null, form({ suggestionId: "s1" }))).toEqual({
      ok: false,
      error: "Something went wrong. Try again.",
    });
    expect(await acceptSuggestionAction(null, form({ suggestionId: "s1" }))).not.toHaveProperty("code");
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
      code: "GONE",
    });
  });
});

describe("excludeDayAction", () => {
  it("marks the day in the actor's workspace, blank reason as null", async () => {
    m.excludeDay.mockResolvedValue({});
    expect(await excludeDayAction(null, form({ w: "test", date: "2026-10-12", reason: " " }))).toEqual({
      ok: true,
      date: "2026-10-12",
    });
    expect(m.requireAdmin).toHaveBeenCalledWith({ w: "test", minRole: "ops" });
    expect(m.excludeDay).toHaveBeenCalledWith("DB", actor, { workspaceId: "ws1", date: "2026-10-12", reason: null });
  });

  it("passes the reason through and maps validation errors", async () => {
    m.excludeDay.mockRejectedValue(new ServiceError("INVALID", "Pick a date."));
    const r = await excludeDayAction(null, form({ date: "", reason: "Road closed at Arambol" }));
    expect(m.excludeDay).toHaveBeenCalledWith("DB", actor, {
      workspaceId: "ws1",
      date: "",
      reason: "Road closed at Arambol",
    });
    expect(r).toEqual({ ok: false, error: "Pick a date.", code: "INVALID" });
  });
});
