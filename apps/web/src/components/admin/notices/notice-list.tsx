"use client";

import { formatIst } from "@eci-shuttle/shared";
import { useTransition } from "react";
import { toast } from "sonner";
import { type ActionResult, endNoticeAction, pinNoticeAction } from "@/app/admin/notices/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Notice } from "@/db/types";
import { NoticeStrip } from "./notice-card";
import { CHANNELS, noticeState, placementLabel, SEVERITIES } from "./notices";

const STATE_LABEL = { showing: "Showing", upcoming: "Upcoming", over: "Over" } as const;

/** Current and upcoming notices with Pin and End, then history. Viewers see no buttons. */
export function NoticeList(props: {
  w: string;
  notices: Notice[];
  names: Record<string, string>;
  now: number;
  canEdit: boolean;
}) {
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<ActionResult>, done: string) =>
    start(async () => {
      const r = await fn();
      if (r.ok) toast.success(done);
      else toast.error(r.error);
    });

  if (props.notices.length === 0) return <p className="text-sm text-muted-foreground">No notices yet.</p>;

  return (
    <ul className="flex flex-col gap-3">
      {props.notices.map((n) => {
        const state = noticeState(n, props.now);
        const over = state === "over";
        return (
          <li key={n.id} className="flex flex-col gap-2 rounded-xl border p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant={state === "showing" ? "default" : "outline"}>{STATE_LABEL[state]}</Badge>
              <span>{SEVERITIES.find((s) => s.value === n.severity)?.label}</span>
              {n.pinned && <span>· pinned{n.sort ? ` #${n.sort}` : ""}</span>}
            </div>
            <NoticeStrip text={n.text} severity={n.severity} pinned={n.pinned} dim={over} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Where</dt>
              <dd>{n.placements.map((p) => placementLabel(p, props.names)).join(", ")}</dd>
              <dt className="text-muted-foreground">From</dt>
              <dd>{formatIst(n.startsAt)}</dd>
              <dt className="text-muted-foreground">Until</dt>
              <dd>
                {n.endedAt && (!n.endsAt || n.endedAt < n.endsAt)
                  ? `${formatIst(n.endedAt)} (ended by hand)`
                  : n.endsAt
                    ? formatIst(n.endsAt)
                    : "ended by hand"}
              </dd>
              {n.channels.length > 0 && (
                <>
                  <dt className="text-muted-foreground">Sent to</dt>
                  <dd>
                    {n.channels.map((c) => CHANNELS.find((x) => x.value === c)?.label).join(", ")}
                    {n.sentAt ? ` · sent ${formatIst(n.sentAt)}` : " · not sent yet"}
                  </dd>
                </>
              )}
            </dl>
            {props.canEdit && !over && (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="h-11"
                  disabled={pending}
                  onClick={() =>
                    act(() => pinNoticeAction(props.w, n.id, !n.pinned, n.version), n.pinned ? "Unpinned" : "Pinned")
                  }
                >
                  {n.pinned ? "Unpin" : "Pin"}
                </Button>
                <Button
                  variant="destructive"
                  className="h-11"
                  disabled={pending}
                  onClick={() => act(() => endNoticeAction(props.w, n.id), "Notice ended")}
                >
                  End now
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
