import { PublicPage } from "@/components/public/public-page";

// live data on every request; never prerendered at build (no DB then)
export const dynamic = "force-dynamic";

export default function Home() {
  return <PublicPage slug={null} />;
}
