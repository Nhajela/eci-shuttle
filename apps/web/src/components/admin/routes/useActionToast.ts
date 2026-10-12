"use client";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import type { ActionState } from "@/app/admin/routes/actions";

type Action = (s: ActionState, fd: FormData) => Promise<ActionState>;

/** useActionState plus a toast for each result. */
export function useActionToast(action: Action, onOk?: () => void) {
  const [state, formAction, pending] = useActionState(action, null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire once per result, not when onOk changes
  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast.success(state.message);
      onOk?.();
    } else toast.error(state.message);
  }, [state]);
  return [formAction, pending] as const;
}
