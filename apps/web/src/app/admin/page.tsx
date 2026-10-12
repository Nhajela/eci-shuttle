import { redirect } from "next/navigation";
import { withWorkspace } from "@/components/admin/shell/nav";

/** admin-shell: admin home is the Live board; keeps `?w=` so a link naming a workspace still lands in it. */
export default async function AdminHome({ searchParams }: { searchParams: Promise<{ w?: string | string[] }> }) {
  const { w } = await searchParams;
  redirect(typeof w === "string" ? withWorkspace("/admin/live", w) : "/admin/live");
}
