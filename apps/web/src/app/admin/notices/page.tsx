import type { Metadata } from "next";

/** admin-notices (SPEC §7): Write once, place anywhere, pin, severity, times, channels, preview. Components live in components/admin/notices/. */
export const metadata: Metadata = { title: "Notices" };

export default function NoticesPage() {
  return <main className="p-4">Notices: not built yet.</main>;
}
