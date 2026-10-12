"use client";

import type { NoticeChannel, NoticePlacement, NoticeSeverity } from "@eci-shuttle/shared";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { createNoticeAction } from "@/app/admin/notices/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { NoticeStrip } from "./notice-card";
import { CHANNELS, istInputToIso, placementLabel, previewPages, SEVERITIES, type Shown } from "./notices";

type Option = { id: string; name: string };

const EMPTY = {
  text: "",
  severity: "info" as NoticeSeverity,
  pinned: false,
  sort: 0,
  starts: "",
  ends: "",
  placements: [] as NoticePlacement[],
  channels: [] as NoticeChannel[],
};

const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

/** Write once, place anywhere: the new-notice form with a live preview of every page it lands on. */
export function NoticeForm(props: { w: string; spots: Option[]; services: Option[]; others: Shown[]; now: number }) {
  const [f, setF] = useState(EMPTY);
  const [pending, start] = useTransition();
  const names = useMemo(
    () => Object.fromEntries([...props.spots, ...props.services].map((o) => [o.id, o.name])),
    [props.spots, props.services],
  );
  const placementOptions: NoticePlacement[] = [
    "everywhere",
    ...props.spots.map((s) => `spot:${s.id}` as const),
    ...props.services.map((s) => `service:${s.id}` as const),
    "schedule",
    "admin",
  ];
  const startsAt = istInputToIso(f.starts);
  const pages = previewPages({ ...f, startsAt }, props.others, names, props.now);
  const set = (patch: Partial<typeof EMPTY>) => setF((cur) => ({ ...cur, ...patch }));

  function save() {
    start(async () => {
      const r = await createNoticeAction(props.w, {
        text: f.text,
        severity: f.severity,
        pinned: f.pinned,
        sort: f.sort,
        startsAt,
        endsAt: istInputToIso(f.ends),
        placements: f.placements,
        channels: f.channels,
      });
      if (r.ok) {
        toast.success("Notice saved");
        setF(EMPTY);
      } else toast.error(r.error);
    });
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="notice-text">Notice</Label>
        <Textarea
          id="notice-text"
          required
          maxLength={1000}
          rows={3}
          value={f.text}
          placeholder="Pickup is at the side gate today"
          onChange={(e) => set({ text: e.target.value })}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Severity</legend>
        <div className="grid grid-cols-3 gap-2">
          {SEVERITIES.map((s) => (
            <Button
              key={s.value}
              type="button"
              className="h-11"
              variant={f.severity === s.value ? "default" : "outline"}
              aria-pressed={f.severity === s.value}
              onClick={() => set({ severity: s.value })}
            >
              {s.label}
            </Button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col">
        <legend className="mb-1 text-sm font-medium">Show it</legend>
        {placementOptions.map((p) => (
          <Label key={p} className="flex min-h-11 items-center gap-3 font-normal">
            <Checkbox
              checked={f.placements.includes(p)}
              onCheckedChange={(on) => set({ placements: toggle(f.placements, p, on) })}
            />
            {placementLabel(p, names)}
          </Label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-2">
        <Label className="flex min-h-11 items-center justify-between gap-3">
          Pin to the top
          <Switch checked={f.pinned} onCheckedChange={(on) => set({ pinned: on })} />
        </Label>
        {f.pinned && (
          <Label className="flex min-h-11 items-center justify-between gap-3 font-normal">
            Order among pinned (lower first)
            <Input
              type="number"
              inputMode="numeric"
              className="h-11 w-20"
              value={f.sort}
              onChange={(e) => set({ sort: Math.trunc(Number(e.target.value)) || 0 })}
            />
          </Label>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="notice-starts">Starts (IST, empty = now)</Label>
          <Input
            id="notice-starts"
            type="datetime-local"
            className="h-11"
            value={f.starts}
            onChange={(e) => set({ starts: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="notice-ends">Ends (IST, empty = until ended)</Label>
          <Input
            id="notice-ends"
            type="datetime-local"
            className="h-11"
            value={f.ends}
            min={f.starts || undefined}
            onChange={(e) => set({ ends: e.target.value })}
          />
        </div>
      </div>

      <fieldset className="flex flex-col">
        <legend className="mb-1 text-sm font-medium">Also send (when it starts)</legend>
        {CHANNELS.map((c) => (
          <Label key={c.value} className="flex min-h-11 items-center gap-3 font-normal">
            <Checkbox
              checked={f.channels.includes(c.value)}
              onCheckedChange={(on) => set({ channels: toggle(f.channels, c.value, on) })}
            />
            <span className="flex flex-col">
              {c.label}
              <span className="text-xs text-muted-foreground">{c.hint}</span>
            </span>
          </Label>
        ))}
      </fieldset>

      <section className="flex flex-col gap-3" aria-label="Preview">
        <h3 className="text-sm font-medium">Preview</h3>
        {pages.length === 0 && <p className="text-sm text-muted-foreground">Pick where to show it to see a preview.</p>}
        {pages.map((p) => (
          <div key={p.placement} className="flex flex-col gap-2 rounded-xl border p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{p.label}</p>
            {p.items.map((i) => (
              <NoticeStrip
                key={i.id}
                {...i}
                dim={!i.isDraft}
                className={i.isDraft ? "ring-2 ring-primary ring-offset-1" : undefined}
              />
            ))}
          </div>
        ))}
      </section>

      <div className="sticky bottom-0 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur">
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={pending || !f.text.trim() || f.placements.length === 0}
        >
          {pending ? "Saving…" : "Save notice"}
        </Button>
      </div>
    </form>
  );
}
