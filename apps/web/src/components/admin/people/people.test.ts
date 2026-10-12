import { describe, expect, it } from "vitest";
import { ServiceError } from "@/services/kernel/errors";
import {
  actionError,
  parseAlertPrefsForm,
  parseRoleForm,
  personName,
  subscriberRows,
  tokenStatus,
  tokenUsed,
} from "./people";

const WS = "11111111-1111-4111-8111-111111111111";
const PID = "22222222-2222-4222-8222-222222222222";

const form = (entries: [string, string][]) => {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
};

describe("personName", () => {
  it("joins names and adds the username", () => {
    expect(personName({ firstName: "Asha", lastName: "Rao", username: "asha" })).toBe("Asha Rao (@asha)");
  });
  it("falls back to the username, then a placeholder", () => {
    expect(personName({ firstName: null, lastName: null, username: "asha" })).toBe("@asha");
    expect(personName({ firstName: null, lastName: null, username: null })).toBe("Unnamed");
  });
});

describe("parseRoleForm", () => {
  it("strips @ and spaces from a username", () => {
    expect(
      parseRoleForm(
        form([
          ["username", "  @asha "],
          ["role", "ops"],
        ]),
        WS,
      ),
    ).toEqual({
      workspaceId: WS,
      person: { username: "asha" },
      role: "ops",
    });
  });
  it("prefers a person id and maps an empty role to removal", () => {
    expect(
      parseRoleForm(
        form([
          ["personId", PID],
          ["username", "x"],
          ["role", ""],
        ]),
        WS,
      ),
    ).toEqual({
      workspaceId: WS,
      person: { personId: PID },
      role: null,
    });
  });
});

describe("parseAlertPrefsForm", () => {
  it("collects kinds, quiet hours and version", () => {
    const fd = form([
      ["kinds", "silent"],
      ["kinds", "digest"],
      ["quietFrom", "23:00"],
      ["quietTo", "06:30"],
      ["version", "3"],
    ]);
    expect(parseAlertPrefsForm(fd, WS)).toEqual({
      workspaceId: WS,
      kinds: ["silent", "digest"],
      quietFrom: "23:00",
      quietTo: "06:30",
      version: 3,
    });
  });
  it("empty times are null and a missing version is undefined", () => {
    expect(
      parseAlertPrefsForm(
        form([
          ["quietFrom", ""],
          ["version", ""],
        ]),
        WS,
      ),
    ).toEqual({
      workspaceId: WS,
      kinds: [],
      quietFrom: null,
      quietTo: null,
      version: undefined,
    });
  });
});

describe("tokens", () => {
  const now = Date.parse("2026-10-12T06:00:00Z");
  const t = { revokedAt: null, expiresAt: null, lastUsedAt: null };
  it("status: active, expired, revoked (revoked wins)", () => {
    expect(tokenStatus(t, now)).toBe("active");
    expect(tokenStatus({ ...t, expiresAt: new Date(now - 1) }, now)).toBe("expired");
    expect(tokenStatus({ ...t, expiresAt: new Date(now + 1) }, now)).toBe("active");
    expect(tokenStatus({ ...t, revokedAt: new Date(now - 5), expiresAt: new Date(now - 1) }, now)).toBe("revoked");
  });
  it("last used is shown in IST", () => {
    expect(tokenUsed(t)).toBe("Never used");
    // 06:00 UTC = 11:30 IST
    expect(tokenUsed({ ...t, lastUsedAt: new Date(now) })).toBe("Last used Mon 12 Oct, 11:30");
  });
});

describe("subscriberRows", () => {
  it("names spots, puts all-spots first, and totals", () => {
    const rows = subscriberRows(
      [
        { spotId: "b", notices: 1, arrivalAlerts: 2 },
        { spotId: null, notices: 4, arrivalAlerts: 0 },
        { spotId: "gone", notices: 1, arrivalAlerts: 0 },
        { spotId: "a", notices: 0, arrivalAlerts: 1 },
      ],
      [
        { id: "a", name: "Riva" },
        { id: "b", name: "Circle" },
      ],
    );
    expect(rows.map((r) => r.name)).toEqual(["All spots", "Circle", "Riva", "Archived spot"]);
    expect(rows[0]).toMatchObject({ notices: 4, arrivalAlerts: 0 });
  });
});

describe("actionError", () => {
  it("passes a service error's message through", () => {
    expect(actionError(new ServiceError("CONFLICT", "Keep at least one admin."))).toEqual({
      ok: false,
      error: "Keep at least one admin.",
    });
  });
  it("hides unexpected errors", () => {
    expect(actionError(new Error("db down"), () => {})).toEqual({
      ok: false,
      error: "Something went wrong. Try again.",
    });
  });
});
