import type { NoticeSeverity } from "@eci-shuttle/shared";
import { cn } from "cn";
import { PinIcon } from "lucide-react";
import { SEVERITY_CLASS } from "./notices";

/** One notice as the public page and admin home draw it: severity colour, pin mark. */
export function NoticeStrip(props: {
  text: string;
  severity: NoticeSeverity;
  pinned: boolean;
  dim?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[15px] leading-snug break-words",
        SEVERITY_CLASS[props.severity],
        props.dim && "opacity-50",
        props.className,
      )}
    >
      {props.pinned && <PinIcon aria-label="Pinned" className="mt-0.5 size-4 shrink-0" />}
      <p className="min-w-0 whitespace-pre-wrap">
        {props.text || <span className="italic opacity-60">Your text</span>}
      </p>
    </div>
  );
}
