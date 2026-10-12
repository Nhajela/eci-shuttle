import { PublicPage } from "@/components/public/public-page";

export default async function WorkspacePage({ params }: { params: Promise<{ slug: string }> }) {
  return <PublicPage slug={(await params).slug} />;
}
