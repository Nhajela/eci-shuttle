"use client";
/** admin-live: run a quick action with a toast, and a two-tap confirm for the ones that change what people see. */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import type { ActionResult } from "@/app/admin/live/actions";
import { Button } from "@/components/ui/button";

export function useQuick() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, done: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(done);
        after?.();
      } else toast.error(r.error);
    });
  return { pending, run };
}

/** First tap asks ("Silence till 10:40?"), second tap does it. */
export function ConfirmButton({
  label,
  question,
  done,
  action,
  destructive,
}: {
  label: string;
  question: string;
  done: string;
  action: () => Promise<ActionResult>;
  destructive?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const { pending, run } = useQuick();
  if (!asking)
    return (
      <Button variant="outline" className="h-11" onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  return (
    <div className="flex w-full flex-wrap items-center gap-2 rounded-xl bg-muted p-2">
      <span className="min-w-0 flex-1 text-sm font-medium">{question}</span>
      <Button variant="ghost" className="h-11" onClick={() => setAsking(false)} disabled={pending}>
        No
      </Button>
      <Button
        variant={destructive ? "destructive" : "default"}
        className="h-11"
        disabled={pending}
        onClick={() => run(action, done, () => setAsking(false))}
      >
        Yes
      </Button>
    </div>
  );
}
