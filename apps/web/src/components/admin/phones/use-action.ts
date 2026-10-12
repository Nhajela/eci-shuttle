"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import type { ActionResult } from "@/app/admin/phones/actions";

/** Run a server action in a transition; toast the outcome. */
export function useAction() {
  const [pending, start] = useTransition();
  const run = <T>(fn: () => Promise<ActionResult<T>>, okText?: string, onOk?: (data: T | undefined) => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error);
      if (okText) toast.success(okText);
      onOk?.(r.data);
    });
  return { pending, run };
}
