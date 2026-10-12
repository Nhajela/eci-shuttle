/** web-public (SPEC §3 Workspaces): `/w/<slug>`, a test workspace's page (with a TEST banner). */
export default async function WorkspacePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <main className="p-4">Workspace {slug}: coming soon.</main>;
}
