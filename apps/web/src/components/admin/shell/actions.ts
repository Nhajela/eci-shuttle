"use server";
/** admin-shell: the workspace switcher. Only a cookie preference (no DB write, so no audit); pages re-check membership. */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { WORKSPACE_COOKIE } from "@/lib/session";
import { safeAdminPath, withWorkspace } from "./nav";

export async function switchWorkspace(form: FormData): Promise<void> {
  const slug = String(form.get("w") ?? "").slice(0, 100);
  const path = safeAdminPath(String(form.get("path") ?? ""));
  if (!slug) redirect(path);
  (await cookies()).set(WORKSPACE_COOKIE, slug, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect(withWorkspace(path, slug));
}
