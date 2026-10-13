"use client";
/**
 * The attendee page (SPEC §6): notices · "Where are you?" · one big answer · today's schedule.
 * Server-rendered with the first answer, then polls /api/status every 10s.
 */
import type { AnswerLine, PublicSpot, PublicStatus } from "@eci-shuttle/shared";
import { cn } from "cn";
import { type ReactNode, useEffect, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ageSeconds, answerParts, contextText, pickSpot, spotCookieName } from "./format";
import { Notices } from "./notices";
import { StaffMap } from "./staff-map";

const POLL_MS = 10_000;

export function StatusView({
  initial,
  slug,
  initialSpotId,
  staff = false,
  info,
}: {
  initial: PublicStatus;
  slug: string | null;
  initialSpotId: string | null;
  /** a logged-in member of this workspace: adds the live map and says "Admin" */
  staff?: boolean;
  /** the workspace's info board, rendered on the server (info-board.tsx) */
  info?: ReactNode;
}) {
  const [status, setStatus] = useState(initial);
  const [chosen, setChosen] = useState(initialSpotId);
  const [failed, setFailed] = useState(false);
  // starts at generatedAt so server and client render the same text
  const [now, setNow] = useState(() => new Date(initial.generatedAt));

  useEffect(() => {
    let stopped = false;
    const url = slug ? `/api/status?w=${encodeURIComponent(slug)}` : "/api/status";
    async function poll() {
      if (document.hidden) return;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as PublicStatus;
        if (!stopped) {
          setStatus(next);
          setFailed(false);
        }
      } catch {
        if (!stopped) setFailed(true);
      }
      if (!stopped) setNow(new Date());
    }
    const timer = setInterval(poll, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug]);

  function choose(spotId: string) {
    setChosen(spotId);
    // biome-ignore lint/suspicious/noDocumentCookie: plain cookie so the server renders the remembered spot first
    document.cookie = `${spotCookieName(slug)}=${encodeURIComponent(spotId)}; path=/; max-age=31536000; samesite=lax`;
  }

  const spotId = pickSpot(status.spots, chosen ?? undefined);
  const spot = status.spots.find((s) => s.spotId === spotId);
  const ageS = ageSeconds(status.generatedAt, now);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 pt-5 pb-10">
      <header className="flex items-center justify-between gap-3">
        <h1 className="flex min-w-0 items-center gap-2 font-heading text-lg font-semibold text-ink">
          <span className="truncate">{status.workspace.name} shuttle</span>
          {!status.workspace.isLive && (
            <span className="rounded-full bg-marigold px-2 py-0.5 text-xs font-bold tracking-wide text-paper">
              TEST
            </span>
          )}
        </h1>
        {/* ops only; /admin sends anyone not logged in to the Telegram login */}
        <a
          href={slug ? `/admin?w=${encodeURIComponent(slug)}` : "/admin"}
          className="inline-flex h-11 shrink-0 items-center rounded-field border border-ink/15 bg-sand px-3 text-sm font-medium text-ink-soft hover:text-ink"
        >
          {staff ? "Admin" : "Admin login"}
        </a>
      </header>

      <aside
        aria-label="Beta"
        className="flex flex-col gap-1.5 rounded-card border-2 border-marigold bg-sand px-4 py-3"
      >
        <p className="flex items-center gap-2 font-heading text-base font-semibold text-ink">
          <span className="rounded-full bg-marigold px-2 py-0.5 text-xs font-bold tracking-wide text-paper">BETA</span>
          Fresh out of the garage
        </p>
        <p className="text-sm leading-snug text-ink-soft">
          This tracker is a few days old and still learning the roads of Mandrem. Shuttles loop roughly every 20–25
          minutes and wait a little at each stop so everyone can hop on. If it says "here now" and you only see cows,
          tell us via @eci_shuttles_bot on Telegram.
        </p>
      </aside>

      {failed && (
        <p role="status" className="rounded-field bg-sand px-3 py-2 text-sm text-ink-soft">
          Can't reach the server right now. Showing the last answer we got.
        </p>
      )}

      <Notices notices={status.notices} />
      {info}

      {status.spots.length === 0 || !spot ? (
        <p className="py-10 text-center text-lg text-ink-soft">No public shuttles are running today.</p>
      ) : (
        <>
          <section aria-labelledby="where" className="flex flex-col gap-2">
            <h2 id="where" className="text-sm font-medium text-ink-soft">
              Where are you?
            </h2>
            <ToggleGroup
              variant="outline"
              spacing={0}
              value={[spot.spotId]}
              onValueChange={(v) => v[0] && choose(String(v[0]))}
              className="w-full"
            >
              {status.spots.map((s) => (
                <ToggleGroupItem
                  key={s.spotId}
                  value={s.spotId}
                  className="h-12 min-w-0 flex-1 shrink text-base data-pressed:bg-ink data-pressed:text-paper"
                >
                  <span className="truncate">{s.shortName || s.name}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </section>

          <Notices notices={spot.notices} />
          <Answer spot={spot} ageS={ageS} />
          {staff && <StaffMap slug={slug} />}
          <Schedule spot={spot} />
        </>
      )}

      <p className="mt-auto text-center text-xs text-ink-mute">Updates every 10 seconds · times in IST</p>
    </main>
  );
}

function Answer({ spot, ageS }: { spot: PublicSpot; ageS: number }) {
  if (spot.answers.length === 0)
    return <p className="text-lg text-ink-soft">No public shuttles stop at {spot.name} today.</p>;
  // a finished service ("no more today") only shows when nothing else is coming today
  const lines = spot.answers.filter((l) => l.kind !== "none");
  if (lines.length === 0) return <p className="text-lg text-ink-soft">No more shuttles today.</p>;
  const single = lines.length === 1;
  return (
    <section aria-live="polite" className="flex flex-col gap-4 rounded-card bg-teal-tint px-4 py-5">
      {lines.map((line) => (
        <AnswerRow key={line.serviceId} line={line} single={single} ageS={ageS} />
      ))}
    </section>
  );
}

function AnswerRow({ line, single, ageS }: { line: AnswerLine; single: boolean; ageS: number }) {
  const p = answerParts(line, single, ageS);
  const big = line.kind !== "none" && !p.small;
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-2 text-base text-ink-soft">
        {line.colour && <span aria-hidden className="size-2.5 rounded-full" style={{ background: line.colour }} />}
        {p.label}
      </p>
      <p className={cn("font-heading font-bold text-ink", big ? "text-5xl leading-none" : "text-2xl")}>
        {p.value}
        {p.range && <span className="ml-2 text-xl font-medium text-ink-soft">({p.range})</span>}
      </p>
      <p className="text-sm text-ink-soft">{contextText(line, ageS)}</p>
      <Notices notices={line.notices} className="mt-1" />
    </div>
  );
}

function Schedule({ spot }: { spot: PublicSpot }) {
  const { rows, loops, notices } = spot.schedule;
  const manyServices = new Set(rows.map((r) => r.serviceId)).size > 1;
  return (
    <section aria-labelledby="schedule" className="flex flex-col gap-3">
      <h2 id="schedule" className="font-heading text-base font-semibold text-ink">
        Today from {spot.name}
      </h2>
      <Notices notices={notices} />
      {loops.map((l) => (
        <p key={l.serviceId} className="text-[15px] text-ink">
          {l.serviceName}: running today
        </p>
      ))}
      {rows.length === 0 && loops.length === 0 && <p className="text-[15px] text-ink-soft">No departures today.</p>}
      {rows.length > 0 && (
        <ol className="flex flex-col">
          {rows.map((r) => (
            <li
              key={`${r.serviceId}-${r.at}`}
              aria-current={r.next ? "true" : undefined}
              className={cn(
                "flex items-center justify-between gap-3 border-b border-line-soft px-2 py-2.5 text-[15px] tabular-nums",
                r.past && "text-ink-mute",
                r.next && "rounded-field border-transparent bg-marigold-tint font-semibold text-ink",
              )}
            >
              <span>{r.label}</span>
              <span className={cn("truncate", r.next ? "text-ink" : "text-ink-soft", r.past && "text-ink-mute")}>
                {r.next ? "next" : ""}
                {r.next && manyServices ? " · " : ""}
                {manyServices ? r.serviceName : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
