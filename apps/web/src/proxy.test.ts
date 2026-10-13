import { NextRequest } from "next/server";
import { expect, it } from "vitest";
import { config, proxy } from "./proxy";

it("passes the exact admin path and query on as x-pathname, overwriting a forged one", () => {
  const req = new NextRequest("https://shuttle.test/admin/phones/abc?w=test&x=1", {
    headers: { "x-pathname": "//evil.com" },
  });
  const res = proxy(req);
  expect(res.headers.get("x-middleware-request-x-pathname")).toBe("/admin/phones/abc?w=test&x=1");
});

it("only runs on admin pages", () => {
  expect(config.matcher).toEqual(["/admin", "/admin/:path*"]);
});
