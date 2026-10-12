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
  const today = istDate(now);
  const [notices, spots, schedule] = await Promise.all([
    listNotices(d, actor, { ...input, includeHistory: true }),
    listSpots(d, actor, { ...input, includeArchived: true }),
    // ponytail: no listServices contract, so services come from the schedule, 14 days back to 14 ahead. The form
    // offers the upcoming ones; the list names any in the window. Older services read "not on the schedule".
    getSchedule(d, actor, { ...input, from: istDate(now - 14 * 86_400_000), days: 28 }),
  ]);
  const toOption = (s: { id: string; name: string }) => ({ id: s.id, name: s.name });
  const services = [
    ...new Map(
      schedule
        .filter((day) => day.date >= today)
        .flatMap((day) => day.services.map(({ service: s }) => [s.id, toOption(s)])),
    ).values(),
  ];
  const spotOptions = spots.filter((s) => !s.archivedAt).map(toOption);
  const names = Object.fromEntries(
    [...spots, ...schedule.flatMap((day) => day.services.map(({ service }) => service))].map((o) => [o.id, o.name]),
  );
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
      {/* On phones the live notices (with Pin and End now) come before the long form. */}
      <section className="order-first flex flex-col gap-3 md:order-none">
        <h2 className="text-lg font-semibold">Notices</h2>
        <NoticeList w={workspace.slug} notices={notices} names={names} now={now} canEdit={canEdit} />
      </section>
    </main>
  );
}
