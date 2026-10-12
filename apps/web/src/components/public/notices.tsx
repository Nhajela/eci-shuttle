import type { PublicNotice } from "@eci-shuttle/shared";
import { cn } from "cn";

const TONE: Record<PublicNotice["severity"], string> = {
  urgent: "border-danger bg-danger-tint text-danger",
  heads_up: "border-marigold bg-marigold-tint text-ink",
  info: "border-line bg-sand text-ink-soft",
};

/** Notices for one placement, in the order the server gives (pinned, urgent, newest). */
export function Notices({ notices, className }: { notices: PublicNotice[]; className?: string }) {
  if (notices.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {notices.map((n) => (
        <li
          key={n.id}
          role={n.severity === "urgent" ? "alert" : undefined}
          className={cn("rounded-field border-l-4 px-3 py-2 text-[15px] leading-snug", TONE[n.severity])}
        >
          {n.text}
        </li>
      ))}
    </ul>
  );
}
