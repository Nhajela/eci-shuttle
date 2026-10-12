"use client";
/** admin-spots (SPEC §7 Spots): list + map of spots, and the editor (pin by tap or "use my location", radius, archive). */
import type { LatLng } from "@eci-shuttle/shared";
import { formatIst } from "@eci-shuttle/shared";
import { LocateFixedIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { archiveSpotAction, saveSpotAction } from "@/app/admin/spots/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { overlapWarnings } from "./overlap";
import { SpotMap } from "./spot-map";

export type SpotView = {
  id: string;
  name: string;
  shortName: string;
  lat: number;
  lng: number;
  radiusM: number;
  notes: string | null;
  archivedAt: Date | null;
  version: number;
};

type Props = { w: string; canEdit: boolean; spots: SpotView[] };

export function SpotsAdmin({ w, canEdit, spots }: Props) {
  const [editing, setEditing] = useState<SpotView | "new" | null>(null);
  const live = spots.filter((s) => !s.archivedAt);
  const archived = spots.filter((s) => s.archivedAt);

  if (editing)
    return (
      <SpotEditor
        key={editing === "new" ? "new" : editing.id}
        w={w}
        spot={editing === "new" ? null : editing}
        all={spots}
        canEdit={canEdit}
        onDone={() => setEditing(null)}
      />
    );

  const open = (id: string) => setEditing(spots.find((s) => s.id === id) ?? null);

  return (
    <main className="mx-auto w-full max-w-5xl p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">Spots</h1>
        {canEdit && (
          <Button className="ml-auto h-11" onClick={() => setEditing("new")}>
            <PlusIcon /> Add spot
          </Button>
        )}
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <SpotMap spots={live} onSelect={open} className="h-64 md:h-[28rem]" />
        <ul className="grid content-start gap-2">
          {live.length === 0 && (
            <li className="text-muted-foreground">No spots yet. Add one by placing a pin on the map.</li>
          )}
          {live.map((s) => (
            <SpotRow key={s.id} spot={s} onOpen={() => setEditing(s)} />
          ))}
        </ul>
      </div>
      {archived.length > 0 && (
        <details className="mt-6">
          <summary className="flex min-h-11 cursor-pointer items-center font-medium">
            Archived ({archived.length})
          </summary>
          <ul className="grid gap-2">
            {archived.map((s) => (
              <SpotRow key={s.id} spot={s} />
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}

function SpotRow({ spot, onOpen }: { spot: SpotView; onOpen?: () => void }) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{spot.name}</span>
        <span className="block text-sm text-muted-foreground">
          {spot.shortName} · {spot.radiusM} m radius
          {spot.archivedAt && ` · archived ${formatIst(spot.archivedAt)}`}
        </span>
      </span>
    </>
  );
  return (
    <li>
      <Card size="sm" className="p-0">
        {onOpen ? (
          <button type="button" onClick={onOpen} className="flex min-h-14 w-full items-center px-4 py-2 text-left">
            {body}
          </button>
        ) : (
          <div className="flex min-h-14 items-center px-4 py-2 text-muted-foreground">{body}</div>
        )}
      </Card>
    </li>
  );
}

function SpotEditor({
  w,
  spot,
  all,
  canEdit,
  onDone,
}: {
  w: string;
  spot: SpotView | null;
  all: SpotView[];
  canEdit: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pin, setPin] = useState<LatLng | null>(spot ? { lat: spot.lat, lng: spot.lng } : null);
  const [radiusM, setRadiusM] = useState(spot?.radiusM ?? 75);
  const [name, setName] = useState(spot?.name ?? "");
  const [shortName, setShortName] = useState(spot?.shortName ?? "");
  const [notes, setNotes] = useState(spot?.notes ?? "");
  const [locating, setLocating] = useState(false);

  const others = useMemo(() => all.filter((s) => s.id !== spot?.id && !s.archivedAt), [all, spot?.id]);
  const draft = pin ? { ...pin, radiusM } : null;
  const warnings = draft ? overlapWarnings({ ...draft, id: spot?.id }, others) : [];

  function locateMe() {
    if (!navigator.geolocation) return toast.error("This browser can't share its location.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        setPin({ lat: p.coords.latitude, lng: p.coords.longitude });
        if (p.coords.accuracy > 50)
          toast.warning(`Location is rough (±${Math.round(p.coords.accuracy)} m). Check the pin.`);
      },
      (e) => {
        setLocating(false);
        toast.error(e.code === e.PERMISSION_DENIED ? "Location permission was denied." : "Couldn't get your location.");
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!pin) return toast.error("Place the pin first: tap the map or use your location.");
    start(async () => {
      const r = await saveSpotAction(w, {
        ...(spot && { spotId: spot.id, version: spot.version }),
        name,
        shortName: shortName || name.slice(0, 24),
        lat: pin.lat,
        lng: pin.lng,
        radiusM,
        notes: notes.trim() || null,
      });
      if (!r.ok) return void toast.error(r.error);
      toast.success(spot ? "Spot saved." : "Spot added.");
      router.refresh();
      onDone();
    });
  }

  function archive() {
    if (!spot || !confirm(`Archive ${spot.name}? It disappears from the public page and from new routes.`)) return;
    start(async () => {
      const r = await archiveSpotAction(w, { spotId: spot.id, version: spot.version });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${spot.name} archived.`);
      router.refresh();
      onDone();
    });
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" className="-ml-3 h-11" onClick={onDone}>
          ← Spots
        </Button>
        <h1 className="truncate text-xl font-semibold">{spot ? spot.name : "New spot"}</h1>
      </div>
      <form onSubmit={save} className="mt-2 grid gap-4 md:grid-cols-2">
        <div className="grid content-start gap-2">
          <SpotMap spots={others} draft={draft} onPick={canEdit ? setPin : undefined} className="h-72 md:h-[28rem]" />
          <p className="text-sm text-muted-foreground">
            {pin
              ? `Pin at ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}. Tap the map to move it.`
              : "Tap the map to drop the pin."}
          </p>
          {canEdit && (
            <Button type="button" variant="outline" className="h-11" onClick={locateMe} disabled={locating}>
              <LocateFixedIcon /> {locating ? "Finding you…" : "Use my current location"}
            </Button>
          )}
        </div>
        <fieldset disabled={!canEdit || pending} className="grid content-start gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="spot-name">Name</Label>
            <Input
              id="spot-name"
              className="h-11"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="spot-short">Short name</Label>
            <Input
              id="spot-short"
              className="h-11"
              maxLength={24}
              placeholder={name.slice(0, 24) || "Shown on the spot toggle"}
              value={shortName}
              onChange={(e) => setShortName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="spot-radius">Arrival radius: {radiusM} m</Label>
            <div className="flex items-center gap-3">
              <input
                id="spot-radius"
                type="range"
                min={10}
                max={300}
                step={5}
                value={Math.min(radiusM, 300)}
                onChange={(e) => setRadiusM(Number(e.target.value))}
                className="h-11 min-w-0 flex-1"
              />
              <Input
                aria-label="Radius in metres"
                type="number"
                inputMode="numeric"
                min={10}
                max={1000}
                className="h-11 w-24"
                value={radiusM}
                onChange={(e) => setRadiusM(Number(e.target.value) || 0)}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              A shuttle inside this circle for 20 s counts as at the spot.
            </p>
          </div>
          {warnings.length > 0 && (
            <div role="alert" className="grid gap-1 rounded-lg bg-amber-100 p-3 text-sm text-amber-950">
              {warnings.map((t) => (
                <p key={t} className="flex gap-2">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden /> {t}
                </p>
              ))}
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="spot-notes">Notes</Label>
            <Textarea id="spot-notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {canEdit && (
            <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 -mx-4 grid gap-2 border-t bg-background px-4 py-3 md:bottom-0">
              <Button type="submit" size="lg" disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
              {spot && (
                <Button type="button" variant="destructive" className="h-11" onClick={archive} disabled={pending}>
                  Archive
                </Button>
              )}
            </div>
          )}
        </fieldset>
      </form>
    </main>
  );
}
