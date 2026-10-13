"use client";
/** On the main page for logged-in staff only (SPEC §6 never shows attendees a map): the Live board's map, polled. */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { StaffMap as Data } from "@/services/public/staff-map";

const AdminMap = dynamic(() => import("@/components/admin/shell/admin-map").then((m) => m.AdminMap), { ssr: false });

const POLL_MS = 10_000;

export function StaffMap({ slug }: { slug: string | null }) {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/staff-map${slug ? `?w=${encodeURIComponent(slug)}` : ""}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: Data | null) => alive && d && setData(d))
        .catch(() => {});
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug]);
  if (!data) return null;
  return (
    <section aria-labelledby="staff-map" className="flex flex-col gap-2">
      <h2 id="staff-map" className="flex items-center gap-2 font-heading text-base font-semibold text-ink">
        Live map
        <span className="rounded-full bg-sand px-2 py-0.5 text-xs font-medium text-ink-soft">staff only</span>
      </h2>
      <div className="h-72 overflow-hidden rounded-card">
        <AdminMap spots={data.spots} paths={data.paths} markers={data.markers} label="Map of shuttles and stops" />
      </div>
    </section>
  );
}
