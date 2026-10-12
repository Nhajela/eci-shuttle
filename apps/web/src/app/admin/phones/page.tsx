import type { Metadata } from "next";

/** admin-phones (SPEC §7): Pair (QR + code), label, assign, health, kill / revoke / nudge, silence, force active, move workspace, OTA. Components live in components/admin/phones/. */
export const metadata: Metadata = { title: "Phones" };

export default function PhonesPage() {
  return <main className="p-4">Phones: not built yet.</main>;
}
