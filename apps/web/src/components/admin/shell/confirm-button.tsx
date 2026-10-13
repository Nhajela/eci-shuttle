"use client";
/**
 * admin-shell: a two-step button for actions that change what people see (SPEC §6c). First tap asks inline
 * ("Kill Van 1?"), second tap does it. Never the browser's confirm().
 */
import type * as React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

type Props = {
  label: string;
  question: string;
  /** what happens, shown under the question */
  description?: string;
  /** the second-tap button; defaults to "Yes" */
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  /** destructive (red) unless it's a routine change like a rollout */
  variant?: "destructive" | "default";
  /** extra fields shown while asking (e.g. a workspace picker) */
  children?: React.ReactNode;
};

export function ConfirmButton({ label, disabled, onConfirm, ...ask }: Props) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button variant="outline" className="h-11" disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  return (
    <ConfirmAsk
      {...ask}
      disabled={disabled}
      onNo={() => setAsking(false)}
      onYes={() => {
        setAsking(false);
        onConfirm();
      }}
    />
  );
}

/** The second step on its own (exported for tests). */
export function ConfirmAsk({
  question,
  description,
  confirmLabel = "Yes",
  variant = "destructive",
  disabled,
  children,
  onNo,
  onYes,
}: Omit<Props, "label" | "onConfirm"> & { onNo: () => void; onYes: () => void }) {
  return (
    <fieldset aria-label={question} className="flex w-full min-w-0 flex-col gap-2 rounded-xl bg-muted p-2">
      <p className="text-sm font-medium">{question}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {children}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" className="h-11" onClick={onNo}>
          No
        </Button>
        <Button variant={variant} className="h-11" disabled={disabled} onClick={onYes}>
          {confirmLabel}
        </Button>
      </div>
    </fieldset>
  );
}
