/** Server side of the attendee page: `/` (slug null = live workspace) and `/w/<slug>`. */
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { currentPerson } from "@/lib/session";
import { membershipsOf } from "@/services/catalog/people";
import { workspaceBySlug } from "@/services/catalog/workspaces";
import { publicStatus } from "@/services/public/status";
import { publicArt } from "./art";
import { pickSpot, spotCookieName } from "./format";
import { InfoBoard } from "./info-board";
import { Scene } from "./scene";
import { StatusView } from "./status-view";

export async function PublicPage({ slug }: { slug: string | null }) {
  const ws = await workspaceBySlug(db(), slug);
  if (!ws) notFound();
  const [status, jar] = await Promise.all([publicStatus(db(), ws.id, new Date()), cookies()]);
  const spotId = pickSpot(status.spots, jar.get(spotCookieName(slug))?.value);
  // a logged-in member of this workspace (any role) also gets the staff map
  const person = await currentPerson();
  const staff = !!person && (await membershipsOf(db(), person.id)).some((m) => m.workspaceId === ws.id);
  // the info board renders here on the server, so the markdown parser stays out of the browser bundle;
  // the painted scene is picked here too (which illustration files exist)
  const art = publicArt();
  return (
    <>
      <Scene art={art} />
      <StatusView
        initial={status}
        slug={slug}
        initialSpotId={spotId}
        staff={staff}
        info={<InfoBoard md={ws.infoMd} />}
        art={art}
      />
    </>
  );
}
