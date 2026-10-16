/**
 * The bot's call to action on the public page: one frosted card with a Telegram button. Tapping Start in the bot's
 * chat sends a plain /start, which subscribes the person to the 15-min updates (bot/attendee.onWelcome).
 */
import { cn } from "cn";

/** https://t.me/<username>; null (no button) without a valid Telegram username. */
export function botLink(username: string | null | undefined): string | null {
  const u = username?.trim().replace(/^@/, "") ?? "";
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(u) ? `https://t.me/${u}` : null;
}

export function BotCta({ href, className }: { href: string; className?: string }) {
  return (
    <section aria-labelledby="bot-cta" className={cn("frosted flex flex-col gap-3 rounded-card p-4", className)}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-3xl leading-none">
          📬
        </span>
        <div className="flex flex-col gap-1">
          <h2 id="bot-cta" className="font-heading text-lg font-bold text-ink">
            Get the shuttle in your pocket
          </h2>
          <p className="text-[15px] text-ink-soft">
            The shuttle bot tells you where the van is every 15 min (or 30, if you like it calm), and when it's heading
            your way. Send "stop" any time.
          </p>
        </div>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-ink px-5 text-base font-medium text-paper hover:bg-ink/90"
      >
        <span aria-hidden>🚐</span> Open the shuttle bot on Telegram
      </a>
    </section>
  );
}
