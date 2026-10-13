"use client";
/** admin-live: the Live board (SPEC §7). List and map side by side on desktop, a Map/List switch on phones. */
import type { LatLng } from "@eci-shuttle/shared";
import { AlertTriangle, Megaphone } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cancelDepartureAction, postNoticeAction } from "@/app/admin/live/actions";
import type { MapSpot } from "@/components/admin/shell/admin-map";
import { ConfirmButton } from "@/components/admin/shell/confirm-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Board } from "./board";
import { useQuick } from "./quick";
import { VehicleCard } from "./vehicle-card";

const AdminMap = dynamic(() => import("@/components/admin/shell/admin-map").then((m) => m.AdminMap), { ssr: false });

const REFRESH_MS = 10_000;

export type AdminNotice = { id: string; text: string; urgent: boolean };

export function LiveBoard({
  board,
  notices,
  spots,
  paths,
  w,
  canAct,
}: {
  board: Board;
  notices: AdminNotice[];
  spots: MapSpot[];
  paths: LatLng[][];
  w: string | null;
  canAct: boolean;
}) {
  const router = useRouter();
  const { pending, run } = useQuick();
  const [view, setView] = useState<"list" | "map">("list");

  useEffect(() => {
    const t = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [router]);

  const vehicles = board.cards.flatMap((c) =>
    c.position
      ? [{ id: c.vehicleId, name: c.name, colour: c.colour, ...c.position, problem: c.problems.length > 0 }]
      : [],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Live</h1>
        {canAct && <PostNotice w={w} />}
      </div>

      {notices.map((n) => (
        <p
          key={n.id}
          className={`rounded-xl p-3 text-sm ${n.urgent ? "bg-orange-100 text-orange-900" : "bg-[var(--teal-tint)]"}`}
        >
          {n.text}
        </p>
      ))}

      {board.otherProblems.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-xl bg-orange-50 p-3 text-sm text-orange-900">
          {board.otherProblems.map((p) => (
            <li key={`${p.kind}:${p.message}`} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {p.message}
            </li>
          ))}
        </ul>
      )}

      {board.nextDepartures.length > 0 && (
        <section aria-labelledby="next-deps" className="flex flex-col gap-2">
          <h2 id="next-deps" className="text-sm font-medium text-muted-foreground">
            Next departures
          </h2>
          {board.nextDepartures.map((d) => (
            <div
              key={`${d.serviceId}:${d.date}:${d.planned}`}
              className="flex flex-wrap items-center gap-2 rounded-xl border p-2 pl-3"
            >
              <span className="min-w-0 flex-1">
                <span className="font-semibold tabular-nums">{d.atText}</span> {d.serviceName}
              </span>
              {canAct && (
                <ConfirmButton
                  label="Cancel"
                  question={`Cancel the ${d.atText} ${d.serviceName}?`}
                  disabled={pending}
                  onConfirm={() =>
                    run(
                      () => cancelDepartureAction(w, d.serviceId, d.date, d.planned),
                      `${d.atText} ${d.serviceName} cancelled`,
                    )
                  }
                />
              )}
            </div>
          ))}
        </section>
      )}

      <ToggleGroup
        className="lg:hidden"
        variant="outline"
        value={[view]}
        onValueChange={(v: string[]) => v[0] && setView(v[0] as "list" | "map")}
      >
        <ToggleGroupItem value="list" className="h-11 flex-1">
          List
        </ToggleGroupItem>
        <ToggleGroupItem value="map" className="h-11 flex-1">
          Map
        </ToggleGroupItem>
      </ToggleGroup>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className={`${view === "list" ? "flex" : "hidden"} flex-col gap-3 lg:flex`}>
          {board.cards.length === 0 && <p className="text-muted-foreground">No active vehicles in this workspace.</p>}
          {board.cards.map((c) => (
            <VehicleCard key={c.vehicleId} card={c} w={w} canAct={canAct} />
          ))}
        </div>
        <div className={`${view === "map" ? "block" : "hidden"} lg:sticky lg:top-4 lg:block lg:self-start`}>
          <AdminMap spots={spots} paths={paths} markers={vehicles} label="Map of vehicles and spots" />
        </div>
      </div>
    </div>
  );
}

function PostNotice({ w }: { w: string | null }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const { pending, run } = useQuick();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="h-11" />}>
        <Megaphone aria-hidden /> Post notice
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Notice for everyone</DialogTitle>
        </DialogHeader>
        <Textarea
          aria-label="Notice text"
          value={text}
          maxLength={1000}
          rows={4}
          placeholder="Bus 2 is off the road this morning. Next one 10:20."
          onChange={(e) => setText(e.target.value)}
        />
        <Label className="flex min-h-11 items-center gap-2">
          <Checkbox checked={urgent} onCheckedChange={(c) => setUrgent(c === true)} />
          Urgent
        </Label>
        <DialogFooter>
          <Button
            className="h-11"
            disabled={pending || !text.trim()}
            onClick={() =>
              run(
                () => postNoticeAction(w, text.trim(), urgent),
                "Notice posted",
                () => {
                  setOpen(false);
                  setText("");
                  setUrgent(false);
                },
              )
            }
          >
            Post
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
