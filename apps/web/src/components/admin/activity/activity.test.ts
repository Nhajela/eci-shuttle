import { describe, expect, it } from "vitest";
import type { AuditRow } from "@/db/types";
import { activityHref, diffEntries, groupByDay, parseActivityParams } from "./activity";

const WS = "5b0e8a2e-6c1f-4f4e-9d0a-1a2b3c4d5e6f";

const row = (o: Partial<AuditRow>): AuditRow => ({
  id: 1,
  workspaceId: WS,
  actorKind: "admin",
  actorId: "p1",
  actorLabel: "Asha",
  channel: "web",
  client: null,
  action: "spot.update",
  entity: "spot",
  entityId: "s1",
  before: null,
  after: null,
  reason: null,
  proposalId: null,
  at: new Date("2026-10-12T04:10:00Z"),
  ...o,
});

describe("parseActivityParams", () => {
  it("maps search params to a listActivity query and the filters to show", () => {
    const { query, filters } = parseActivityParams(
      { w: "live", entity: "spot", entityId: "s1", actor: "p1", proposal: "pr1", since: "2026-10-12", before: "120" },
      WS,
    );
    // since is the start of that IST day
    expect(query).toEqual({
      workspaceId: WS,
      entity: "spot",
      entityId: "s1",
      actorId: "p1",
      proposalId: "pr1",
      since: "2026-10-11T18:30:00.000Z",
      before: 120,
      limit: 50,
    });
    expect(filters).toEqual({
      w: "live",
      entity: "spot",
      entityId: "s1",
      actor: "p1",
      proposal: "pr1",
      since: "2026-10-12",
    });
  });

  it("drops empty, malformed and repeated values instead of failing the page", () => {
    const { query, filters } = parseActivityParams(
      { entity: "", since: "12/10/2026", before: "abc", actor: ["a", "b"], entityId: "x" },
      WS,
    );
    // entityId only means something with an entity
    expect(query).toEqual({ workspaceId: WS, limit: 50 });
    expect(filters).toEqual({});
  });

  it("rejects a non-positive cursor and an impossible date", () => {
    const { query } = parseActivityParams({ before: "0", since: "2026-13-40" }, WS);
    expect(query).toEqual({ workspaceId: WS, limit: 50 });
  });
});

describe("activityHref", () => {
  it("keeps the current filters, applies the patch and drops empty ones", () => {
    expect(activityHref({ w: "test", entity: "spot", entityId: "s1" }, { entityId: undefined, actor: "p 1" })).toBe(
      "/admin/activity?w=test&entity=spot&actor=p+1",
    );
  });

  it("clearing the entity also clears the object timeline", () => {
    expect(activityHref({ w: "live", entity: "spot", entityId: "s1" }, { entity: undefined })).toBe(
      "/admin/activity?w=live",
    );
  });

  it("is the bare page with no filters", () => {
    expect(activityHref({}, {})).toBe("/admin/activity");
  });
});

describe("groupByDay", () => {
  it("groups newest-first rows by IST calendar day, across the UTC midnight", () => {
    const rows = [
      row({ id: 3, at: new Date("2026-10-12T19:00:00Z") }), // 00:30 IST on the 13th
      row({ id: 2, at: new Date("2026-10-12T18:00:00Z") }), // 23:30 IST on the 12th
      row({ id: 1, at: new Date("2026-10-12T04:10:00Z") }),
    ];
    const days = groupByDay(rows);
    expect(days.map((d) => [d.day, d.label, d.rows.map((r) => r.id)])).toEqual([
      ["2026-10-13", "Tue 13 Oct", [3]],
      ["2026-10-12", "Mon 12 Oct", [2, 1]],
    ]);
  });

  it("is empty for no rows", () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe("diffEntries", () => {
  it("lists each changed field with readable before and after values", () => {
    const r = row({
      before: { name: "Riva", radiusM: 80, version: 1 },
      after: { name: "Riva gate", radiusM: 120, version: 2 },
    });
    expect(diffEntries(r)).toEqual([
      { field: "name", before: "Riva", after: "Riva gate" },
      { field: "radiusM", before: "80", after: "120" },
    ]);
  });

  it("shows a create as fields with no before, and objects as JSON", () => {
    const r = row({ after: { name: "Beach", spotIds: ["a", "b"], notes: null } });
    expect(diffEntries(r)).toEqual([
      { field: "name", before: null, after: "Beach" },
      { field: "spotIds", before: null, after: '["a","b"]' },
      { field: "notes", before: null, after: "—" },
    ]);
  });

  it("shows a delete as fields with no after", () => {
    expect(diffEntries(row({ before: { name: "Old" } }))).toEqual([{ field: "name", before: "Old", after: null }]);
  });

  it("is empty when nothing was recorded", () => {
    expect(diffEntries(row({}))).toEqual([]);
  });
});
