import { describe, expect, it } from "vitest";
import {
  isActive,
  MORE,
  pickWorkspace,
  type ShellWorkspace,
  STICKY_SAVE,
  safeAdminPath,
  TABS,
  withWorkspace,
} from "./nav";

const ws = (slug: string, isLive = false): ShellWorkspace => ({ slug, name: slug.toUpperCase(), isLive, role: "ops" });
const list = [ws("eci", true), ws("test")];

describe("nav items", () => {
  it("phone tabs are Live, Schedule, Notices, Phones, More (SPEC §7)", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Live", "Schedule", "Notices", "Phones"]);
  });
  it("More holds every other admin page, each once", () => {
    const hrefs = [...TABS, ...MORE].map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const p of ["vehicles", "people", "spots", "routes", "insights", "activity", "workspaces"]) {
      expect(MORE.map((i) => i.href)).toContain(`/admin/${p}`);
    }
  });
});

describe("pickWorkspace", () => {
  it("?w= wins when the person is a member", () => {
    expect(pickWorkspace(list, "test", "eci")?.slug).toBe("test");
  });
  it("unknown ?w= falls back to live, like requireAdmin, never to the cookie workspace", () => {
    expect(pickWorkspace(list, "other", "test")?.slug).toBe("eci");
    expect(pickWorkspace([ws("a"), ws("b")], "other", "b")?.slug).toBe("a");
  });
  it("no ?w= uses the fallback, then the first", () => {
    expect(pickWorkspace(list, null, "test")?.slug).toBe("test");
    expect(pickWorkspace(list, null, "gone")?.slug).toBe("eci");
  });
  it("empty list → null", () => {
    expect(pickWorkspace([], "eci", "eci")).toBeNull();
  });
});

describe("STICKY_SAVE", () => {
  it("sits above the phone tab bar", () => {
    expect(STICKY_SAVE).toContain("bottom-[var(--admin-tabbar)]");
  });
});

describe("withWorkspace", () => {
  it("carries the workspace on every link, encoded", () => {
    expect(withWorkspace("/admin/live", "test")).toBe("/admin/live?w=test");
    expect(withWorkspace("/admin/live", "a b")).toBe("/admin/live?w=a%20b");
  });
});

describe("isActive", () => {
  it("matches the page and its sub-pages only", () => {
    expect(isActive("/admin/live", "/admin/live")).toBe(true);
    expect(isActive("/admin/phones/123", "/admin/phones")).toBe(true);
    expect(isActive("/admin/phonesx", "/admin/phones")).toBe(false);
    expect(isActive("/admin/live", "/admin/schedule")).toBe(false);
  });
});

describe("safeAdminPath", () => {
  it("keeps admin paths", () => {
    expect(safeAdminPath("/admin/phones")).toBe("/admin/phones");
    expect(safeAdminPath("/admin")).toBe("/admin");
  });
  it("refuses anything that could leave admin (open redirect)", () => {
    for (const bad of [
      "https://evil.com/admin",
      "//evil.com",
      "/admin/../login",
      "/adminx",
      "/admin\\evil",
      "",
      null,
    ]) {
      expect(safeAdminPath(bad)).toBe("/admin/live");
    }
  });
});
