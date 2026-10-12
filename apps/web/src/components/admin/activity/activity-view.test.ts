import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AuditRow } from "@/db/types";
import { ActivityView } from "./activity-view";

// svc-activity owns the wording; here we only check the page shows it
vi.mock("@/services/activity/activity", () => ({ describeAudit: (r: AuditRow) => `line for ${r.action}` }));

const row = (o: Partial<AuditRow>): AuditRow => ({
  id: 1,
  workspaceId: "ws",
  actorKind: "admin",
  actorId: "p1",
  actorLabel: "Asha",
  channel: "web",
  client: null,
  action: "spot.update",
  entity: "spot",
  entityId: "s1",
  before: { name: "Riva" },
  after: { name: "Riva gate" },
  reason: "gate moved",
  proposalId: "pr1",
  at: new Date("2026-10-12T04:10:00Z"),
  ...o,
});

const render = (props: Parameters<typeof ActivityView>[0]) =>
  renderToStaticMarkup(createElement(ActivityView, props)).replaceAll("&amp;", "&");

describe("ActivityView", () => {
  it("shows each row with its IST time, line, reason, diff and filter links", () => {
    const html = render({ page: { rows: [row({})], nextBefore: 1 }, filters: { w: "live" }, paged: false });
    expect(html).toContain("Mon 12 Oct");
    expect(html).toContain("09:40");
    expect(html).toContain("line for spot.update");
    expect(html).toContain("gate moved");
    expect(html).toContain("Riva gate");
    expect(html).toContain('href="/admin/activity?w=live&entity=spot&entityId=s1"');
    expect(html).toContain('href="/admin/activity?w=live&actor=p1"');
    expect(html).toContain('href="/admin/activity?w=live&proposal=pr1"');
    expect(html).toContain('href="/admin/activity?w=live&before=1"');
    expect(html).not.toContain(">Newest<");
  });

  it("offers to clear a narrowing filter and go back to the newest page", () => {
    const html = render({
      page: { rows: [], nextBefore: null },
      filters: { w: "live", entity: "spot", entityId: "s1" },
      paged: true,
    });
    expect(html).toContain('href="/admin/activity?w=live&entity=spot"');
    expect(html).toContain(">Newest<");
    expect(html).toContain("No older changes.");
    expect(html).not.toContain(">Older<");
  });

  it("says so when nothing matches", () => {
    expect(render({ page: { rows: [], nextBefore: null }, filters: {}, paged: false })).toContain(
      "Nothing changed yet with these filters.",
    );
  });
});
