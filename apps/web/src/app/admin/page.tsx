import { redirect } from "next/navigation";

/** admin-shell: admin home is the Live board. */
export default function AdminHome() {
  redirect("/admin/live");
}
