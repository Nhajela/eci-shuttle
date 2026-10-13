"use client";
/** admin-live: run a quick action with a toast. */
import { useTransition } from "react";
import { toast } from "sonner";
import type { ActionResult } from "@/app/admin/live/actions";

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
