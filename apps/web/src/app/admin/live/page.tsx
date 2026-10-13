import { istDate } from "@eci-shuttle/shared";
import type { Metadata } from "next";
import { buildBoard } from "@/components/admin/live/board";
import { LiveBoard } from "@/components/admin/live/live-board";
import { waitingView } from "@/components/admin/live/waiting";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { detectProblems } from "@/services/alerts/watchdog";
import { activeBreaks } from "@/services/catalog/breaks";
import { listRoutes } from "@/services/catalog/routes";
import { getSchedule } from "@/services/catalog/schedule";
import { listSpots } from "@/services/catalog/spots";
import { listVehicles } from "@/services/catalog/vehicles";
import { listPhones } from "@/services/devices/phones";
import { vehicleStates } from "@/services/ingest/ingest";
import { activeNotices } from "@/services/notices/notices";
import { waitingAtSpots } from "@/services/subscriptions/need";

/** admin-live (SPEC §7): Live board: every vehicle's phase, ETA, last seen, battery, service; problems flagged; admin notices. Components live in components/admin/live/. */
export const metadata: Metadata = { title: "Live" };
export const dynamic = "force-dynamic";

export default async function LivePage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const w = (await searchParams).w ?? null;
  const { actor, workspace, role } = await requireAdmin({ w });
  const now = new Date();
  const d = db();
  const workspaceId = workspace.id;
  const [vehicles, states, phones, problems, schedule, spots, routes, notices, breaks, waiting] = await Promise.all([
    listVehicles(d, actor, { workspaceId }),
    vehicleStates(d, workspaceId),
    listPhones(d, actor, { workspaceId }, now),
    detectProblems(d, workspaceId, now),
    // from yesterday: a service running past midnight belongs to the previous IST day
    getSchedule(d, actor, { workspaceId, from: istDate(now.getTime() - 86_400_000), days: 2 }),
    listSpots(d, actor, { workspaceId }),
    listRoutes(d, actor, { workspaceId }),
    activeNotices(d, workspaceId, now, ["admin"]),
    activeBreaks(d, workspaceId, now),
    waitingAtSpots(d, actor, { workspaceId }, now),
  ]);
  const board = buildBoard({ vehicles, states, phones, problems, breaks, schedule, spots }, now.getTime());

  return (
    <LiveBoard
      board={board}
      notices={notices.map((n) => ({ id: n.id, text: n.text, urgent: n.severity === "urgent" }))}
      waiting={waitingView(waiting, now.getTime())}
      spots={spots.map((s) => ({ id: s.id, name: s.shortName, lat: s.lat, lng: s.lng, radiusM: s.radiusM }))}
      paths={routes.filter((r) => !r.archivedAt).map((r) => r.path)}
      w={w}
      canAct={role !== "viewer"}
    />
  );
}
