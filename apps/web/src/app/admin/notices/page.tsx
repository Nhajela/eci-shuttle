import type { Metadata } from "next";
import { InfoForm } from "@/components/admin/notices/info-form";
import { NoticeForm } from "@/components/admin/notices/notice-form";
import { NoticeList } from "@/components/admin/notices/notice-list";
import { noticeState } from "@/components/admin/notices/notices";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { listServices } from "@/services/catalog/schedule";
import { listSpots } from "@/services/catalog/spots";
import { can } from "@/services/kernel";
import { listNotices } from "@/services/notices/notices";

/** admin-notices (SPEC §7): the info board, then notices: write once, place anywhere, pin, severity, times, channels, preview. Components live in components/admin/notices/. */
export const metadata: Metadata = { title: "Notices" };

export default async function NoticesPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const { workspace, actor } = await requireAdmin({ w });
  const now = Date.now();
  const d = db();
  const input = { workspaceId: workspace.id };
  const [notices, spots, services] = await Promise.all([
    listNotices(d, actor, { ...input, includeHistory: true }),
    listSpots(d, actor, { ...input, includeArchived: true }),
    listServices(d, actor, input),
  ]);
  const toOption = (s: { id: string; name: string }) => ({ id: s.id, name: s.name });
  const spotOptions = spots.filter((s) => !s.archivedAt).map(toOption);
  const names = Object.fromEntries([...spots, ...services].map((o) => [o.id, o.name]));
  const canEdit = can(actor, workspace.id, "ops");

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:grid md:grid-cols-2 md:items-start">
      <section className="flex flex-col gap-3 md:col-span-2">
        <h2 className="text-lg font-semibold">Info board</h2>
        <InfoForm w={workspace.slug} infoMd={workspace.infoMd} version={workspace.version} canEdit={canEdit} />
      </section>
      {canEdit && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">New notice</h2>
          <NoticeForm
            w={workspace.slug}
            spots={spotOptions}
            services={services.map(toOption)}
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
