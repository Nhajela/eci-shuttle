import { istDate } from "@eci-shuttle/shared";
import type { Metadata } from "next";
import { NoticeForm } from "@/components/admin/notices/notice-form";
import { NoticeList } from "@/components/admin/notices/notice-list";
import { noticeState } from "@/components/admin/notices/notices";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { getSchedule } from "@/services/catalog/schedule";
import { listSpots } from "@/services/catalog/spots";
import { can } from "@/services/kernel";
import { listNotices } from "@/services/notices/notices";

/** admin-notices (SPEC §7): Write once, place anywhere, pin, severity, times, channels, preview. Components live in components/admin/notices/. */
export const metadata: Metadata = { title: "Notices" };

export default async function NoticesPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const { workspace, actor } = await requireAdmin({ w });
  const now = Date.now();
  const d = db();
  const input = { workspaceId: workspace.id };
  const [notices, spots, schedule] = await Promise.all([
    listNotices(d, actor, { ...input, includeHistory: true }),
    listSpots(d, actor, input),
    // ponytail: services come from the next two weeks of the schedule (no listServices contract); a service not
    // running in that window can't be picked here.
    getSchedule(d, actor, { ...input, from: istDate(now), days: 14 }),
  ]);
  const services = [
    ...new Map(
      schedule.flatMap((day) => day.services.map(({ service: s }) => [s.id, { id: s.id, name: s.name }])),
    ).values(),
  ];
  const spotOptions = spots.map((s) => ({ id: s.id, name: s.name }));
  const names = Object.fromEntries([...spotOptions, ...services].map((o) => [o.id, o.name]));
  const canEdit = can(actor, workspace.id, "ops");

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:grid md:grid-cols-2 md:items-start">
      {canEdit && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">New notice</h2>
          <NoticeForm
            w={workspace.slug}
            spots={spotOptions}
            services={services}
            others={notices.filter((n) => noticeState(n, now) !== "over")}
            now={now}
          />
        </section>
      )}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Notices</h2>
        <NoticeList w={workspace.slug} notices={notices} names={names} now={now} canEdit={canEdit} />
      </section>
    </main>
  );
}
