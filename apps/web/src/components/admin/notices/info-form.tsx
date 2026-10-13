"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setInfoAction } from "@/app/admin/notices/actions";
import { InfoBoard } from "@/components/public/info-board";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const PLACEHOLDER = `## Nanu Resort
**Pickup at 08:00** every morning to Riva and Circle.
The rest of the day the shuttle runs Riva ↔ Circle.

- Ask at reception for the pickup point
- [Map](https://maps.app.goo.gl/…)`;

/** The info board on the public page: one markdown text per workspace, shown until changed (no times). */
export function InfoForm(props: { w: string; infoMd: string | null; version: number; canEdit: boolean }) {
  const [md, setMd] = useState(props.infoMd ?? "");
  const [preview, setPreview] = useState(false);
  const [pending, start] = useTransition();
  const changed = md.trim() !== (props.infoMd ?? "");

  function save() {
    start(async () => {
      const r = await setInfoAction(props.w, md, props.version);
      if (r.ok) toast.success(md.trim() ? "Info board saved" : "Info board cleared");
      else toast.error(r.error);
    });
  }

  if (!props.canEdit)
    return props.infoMd ? (
      <InfoBoard md={props.infoMd} />
    ) : (
      <p className="text-sm text-muted-foreground">No info board.</p>
    );

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="info-md">Markdown, shown on the public page under the notices</Label>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            size="sm"
            className="h-11"
            variant={preview ? "outline" : "default"}
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-11"
            variant={preview ? "default" : "outline"}
            aria-pressed={preview}
            onClick={() => setPreview(true)}
          >
            Preview
          </Button>
        </div>
      </div>
      {preview ? (
        md.trim() ? (
          <InfoBoard md={md} />
        ) : (
          <p className="text-sm text-muted-foreground">Empty: the public page shows no info board.</p>
        )
      ) : (
        <Textarea
          id="info-md"
          maxLength={5000}
          rows={8}
          value={md}
          placeholder={PLACEHOLDER}
          onChange={(e) => setMd(e.target.value)}
          className="font-mono text-sm"
        />
      )}
      <p className="text-xs text-muted-foreground">
        **bold**, ## heading, - list, [link](https://…). Stays up until you change it; leave empty to hide it.
      </p>
      <div className="sticky bottom-0 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur">
        <Button type="submit" size="lg" className="w-full" disabled={pending || !changed}>
          {pending ? "Saving…" : "Save info board"}
        </Button>
      </div>
    </form>
  );
}
