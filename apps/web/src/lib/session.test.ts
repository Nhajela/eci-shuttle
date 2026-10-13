import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ reqHeaders: new Headers() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => h.reqHeaders,
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { requireAdmin, safeNext } = await import("./session");

beforeEach(() => {
  process.env.SESSION_SECRET = "x".repeat(32);
  h.reqHeaders = new Headers();
});

it("safeNext keeps same-site paths and refuses open redirects", () => {
  expect(safeNext("/admin/live?w=test")).toBe("/admin/live?w=test");
  for (const bad of [null, undefined, "", "https://evil.com", "//evil.com", "/\\evil.com", "/\t/evil.com", "admin"])
    expect(safeNext(bad)).toBe("/admin");
});

const login = (next: string) => `REDIRECT /login?next=${encodeURIComponent(next)}`;

it("logged out: returns to the exact page from the proxy's x-pathname header", async () => {
  h.reqHeaders.set("x-pathname", "/admin/phones/abc?w=test");
  await expect(requireAdmin({ w: "test" })).rejects.toThrow(login("/admin/phones/abc?w=test"));
});

it("logged out: an explicit next wins over the header", async () => {
  h.reqHeaders.set("x-pathname", "/admin/live");
  await expect(requireAdmin({ next: "/admin/schedule?d=2026-10-14" })).rejects.toThrow(
    login("/admin/schedule?d=2026-10-14"),
  );
});

it("logged out: no header falls back to /admin keeping ?w=", async () => {
  await expect(requireAdmin({ w: "test" })).rejects.toThrow(login("/admin?w=test"));
  await expect(requireAdmin({})).rejects.toThrow(login("/admin"));
});

it("logged out: an unsafe next or header never becomes the redirect target", async () => {
  h.reqHeaders.set("x-pathname", "//evil.com");
  await expect(requireAdmin({})).rejects.toThrow(login("/admin"));
  await expect(requireAdmin({ next: "https://evil.com" })).rejects.toThrow(login("/admin"));
});
