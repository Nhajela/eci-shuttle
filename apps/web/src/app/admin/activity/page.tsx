import type { Metadata } from "next";
import { parseActivityParams } from "@/components/admin/activity/activity";
import { ActivityView } from "@/components/admin/activity/activity-view";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { listActivity } from "@/services/activity/activity";

/** admin-activity (SPEC §7): The audit log, filterable by entity. Components live in components/admin/activity/. */
export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { workspace, actor } = await requireAdmin({ w: typeof sp.w === "string" ? sp.w : null });
  const { query, filters } = parseActivityParams(sp, workspace.id);
  const page = await listActivity(db(), actor, query);
  return <ActivityView page={page} filters={filters} paged={query.before !== undefined} />;
}
