"use client";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export type ActionState = { ok: boolean; error?: string } | null;
export type FormAction = (state: ActionState, fd: FormData) => Promise<ActionState>;

/** A form posting to a server action: disables while saving, shows the plain-English error, toasts success. */
export function ActionForm({
  action,
  success,
  className,
  children,
}: {
  action: FormAction;
  success: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  useEffect(() => {
    if (state?.ok) toast.success(success);
  }, [state, success]);
  return (
    <form action={formAction} className={cn("flex flex-col gap-3", className)}>
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** Native inputs styled like ui/input, at least 44px tall for thumbs. */
export const field =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
