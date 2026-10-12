import type { Metadata } from "next";

/** admin-live (SPEC §7): Live board: every vehicle's phase, ETA, last seen, battery, service; problems flagged; admin notices. Components live in components/admin/live/. */
export const metadata: Metadata = { title: "Live" };

export default function LivePage() {
  return <main className="p-4">Live: not built yet.</main>;
}
