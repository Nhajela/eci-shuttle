"use client";
/**
 * The attendee page (SPEC §6): notices · "Where are you?" · one big answer · today's schedule, wrapped in a little
 * whimsy: a painted scene behind, frosted cards in front, a van strip and the live 3D map under the answer.
 * The plain answer always comes first and reads on its own. Server-rendered with the first answer, then polls
 * /api/status every 10s. Never lateness (§6a.2).
 */
import { type AnswerLine, istHHMM, type PublicSpot, type PublicStatus } from "@eci-shuttle/shared";
import { cn } from "cn";
import { type ReactNode, useEffect, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { PublicMap } from "@/services/public/positions";
import type { PublicArt } from "./art";
import { BotCta } from "./bot-cta";
import { ageSeconds, answerParts, contextText, pickSpot, scheduleWindow, spotCookieName } from "./format";
import { PublicMapCard } from "./map/public-map";
import { usePositions } from "./map/use-positions";
import { Notices } from "./notices";
import { StaffMap } from "./staff-map";
import { pageStory, type Story } from "./story";
import { stripLayout, VanStrip } from "./van-strip";
import { mood, noShuttleMood } from "./whimsy";

const POLL_MS = 10_000;

export function StatusView({
  initial,
  slug,
  initialSpotId,
  staff = false,
  info,
  art,
  botUrl = null,
}: {
  initial: PublicStatus;
  slug: string | null;
  initialSpotId: string | null;
  /** a logged-in member of this workspace: adds the staff map and says "Admin" */
  staff?: boolean;
  /** the workspace's info board, rendered on the server (info-board.tsx) */
  info?: ReactNode;
  /** which illustration files exist (art.ts, server side) */
  art?: PublicArt;
  /** the Telegram bot's link (bot-cta.botLink); null hides the card */
  botUrl?: string | null;
}) {
  const sprite = art?.sceneLayers.find((f) => /\/van\.(webp|png)$/i.test(f)) ?? null;
  const [status, setStatus] = useState(initial);
  const [chosen, setChosen] = useState(initialSpotId);
  const [failed, setFailed] = useState(false);
  // starts at generatedAt so server and client render the same text
  const [now, setNow] = useState(() => new Date(initial.generatedAt));
  const positions = usePositions(slug, status.spots.length > 0);

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
  const hour = Number(istHHMM(now.getTime()).slice(0, 2));
  const strip = positions && spot ? stripLayout(positions, spot.spotId) : null;
  const nothing = status.spots.length === 0 || !spot;

  return (
    <main className="relative z-10 mx-auto grid w-full max-w-md flex-1 grid-cols-1 gap-4 px-4 pt-4 pb-10 lg:max-w-6xl lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start lg:gap-6 lg:px-8">
      <div className="flex min-w-0 flex-col gap-4 lg:col-start-1">
        <header className="flex items-center justify-between gap-3">
          <p className="frosted flex min-w-0 items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold text-ink">
            <span className="truncate">{status.workspace.name} shuttle</span>
            {!status.workspace.isLive && (
              <span className="rounded-full bg-marigold px-2 py-0.5 text-[11px] font-bold tracking-wide text-paper">
                TEST
              </span>
            )}
          </p>
          {/* ops only; /admin sends anyone not logged in to the Telegram login */}
          <a
            href={slug ? `/admin?w=${encodeURIComponent(slug)}` : "/admin"}
            className="frosted inline-flex h-11 shrink-0 items-center rounded-full px-4 text-sm font-medium text-ink-soft hover:text-ink"
          >
            {staff ? "Admin" : "Admin login"}
          </a>
        </header>

        {/* the painting shows through here */}
        <div className="flex min-h-[30vh] flex-col justify-end gap-1 pt-6 lg:min-h-[14vh]">
          <h1 className="font-heading text-4xl font-bold leading-[1.05] tracking-tight text-ink drop-shadow-[0_1px_0_var(--paper)]">
            Where's the shuttle?
          </h1>
          <p className="text-[15px] font-medium text-ink-soft">
            {status.spots.length > 1
              ? `${status.spots.map((s) => s.shortName || s.name).join(" ⇄ ")} · live, in IST`
              : "Live, in IST"}
          </p>
        </div>

        {failed && (
          <p role="status" className="frosted rounded-field px-3 py-2 text-sm text-ink-soft">
            Can't reach the server right now. Showing the last answer we got.
          </p>
        )}

        <Notices notices={status.notices} />
        {info}

        {nothing ? (
          <section className="frosted flex flex-col items-center gap-2 rounded-card px-4 py-8 text-center">
            {sprite ? (
              // biome-ignore lint/performance/noImgElement: static webp straight from /public
              <img src={sprite} alt="" className="scene-van mb-2 w-48" />
            ) : (
              <span className="text-4xl" aria-hidden>
                {noShuttleMood(hour).emoji}
              </span>
            )}
            <p className="font-heading text-xl font-bold text-ink">No public shuttles are running today.</p>
            <p className="text-[15px] text-ink-soft">{noShuttleMood(hour).text}</p>
          </section>
        ) : (
          <section aria-labelledby="where" className="frosted flex flex-col gap-4 rounded-card p-4">
            <div className="flex flex-col gap-2">
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
                    className="h-12 min-w-0 flex-1 shrink bg-paper text-base data-pressed:bg-ink data-pressed:text-paper"
                  >
                    <span className="truncate">{s.shortName || s.name}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <Notices notices={spot.notices} />
            <Answer
              spot={spot}
              spots={status.spots}
              positions={positions}
              nowMs={now.getTime()}
              ageS={ageS}
              hour={hour}
            />
            {strip && strip.stops.length > 1 && <VanStrip layout={strip} className="-mx-1 -mb-1" />}
          </section>
        )}
        {botUrl && <BotCta href={botUrl} />}
      </div>

      {!nothing && (
        <div className="min-w-0 lg:sticky lg:top-4 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:h-[calc(100dvh-2rem)]">
          <PublicMapCard data={positions} sprite={sprite} className="shadow-[0_18px_40px_-20px_rgba(20,27,52,0.45)]" />
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-4 lg:col-start-1">
        {!nothing && (
          <section className="frosted rounded-card p-4">
            <Schedule spot={spot} />
          </section>
        )}
        {staff && !nothing && <StaffMap slug={slug} />}
        <aside
          aria-label="Beta"
          className="frosted flex flex-col gap-1.5 rounded-card border border-marigold/60 px-4 py-3"
        >
          <p className="flex items-center gap-2 font-heading text-[15px] font-semibold text-ink">
            <span className="rounded-full bg-marigold px-2 py-0.5 text-[11px] font-bold tracking-wide text-paper">
              BETA
            </span>
            Fresh out of the garage
          </p>
          <p className="text-sm leading-snug text-ink-soft">
            This tracker is a few days old and still learning the roads of Mandrem. Shuttles loop roughly every 20–25
            minutes and wait a little at each stop so everyone can hop on. If it says "here now" and you only see cows,
            tell us via @eci_shuttles_bot on Telegram.
          </p>
        </aside>
        <p className="mt-auto text-center text-xs text-ink-mute">Updates every 10 seconds · times in IST</p>
      </div>
    </main>
  );
}

function Answer({
  spot,
  spots,
  positions,
  nowMs,
  ageS,
  hour,
}: {
  spot: PublicSpot;
  spots: PublicSpot[];
  positions: PublicMap | null;
  nowMs: number;
  ageS: number;
  hour: number;
}) {
  const m = noShuttleMood(hour);
  if (spot.answers.length === 0)
    return (
      <p className="text-lg text-ink-soft">
        No public shuttles stop at {spot.name} today. {m.emoji}
      </p>
    );
  // a finished service ("no more today") only shows when nothing else is coming today
  const lines = spot.answers.filter((l) => l.kind !== "none");
  if (lines.length === 0) {
    const done = mood(spot.answers[0] as AnswerLine, ageS, hour);
    return (
      <div className="flex flex-col gap-1">
        <p className="font-heading text-3xl font-bold text-ink">No more shuttles today.</p>
        <p className="text-[15px] text-ink-soft">
          <span aria-hidden>{done.emoji}</span> {done.text}
        </p>
      </div>
    );
  }
  const single = lines.length === 1;
  return (
    <section aria-live="polite" className="flex flex-col gap-4">
      {lines.map((line) => (
        <AnswerRow
          key={line.serviceId}
          line={line}
          single={single}
          ageS={ageS}
          hour={hour}
          story={
            positions
              ? pageStory({
                  line,
                  spot,
                  spots,
                  vehicles: positions.vehicles,
                  routes: positions.routes,
                  nowMs,
                  ageS,
                })
              : null
          }
        />
      ))}
    </section>
  );
}

function AnswerRow({
  line,
  single,
  ageS,
  hour,
  story,
}: {
  line: AnswerLine;
  single: boolean;
  ageS: number;
  hour: number;
  /** what the shuttle is doing (story.ts), over the usual minutes when it says more truthfully */
  story: Story | null;
}) {
  const usual = answerParts(line, single, ageS);
  const p = story
    ? {
        ...usual,
        label: single ? story.label : usual.label,
        value: story.value ?? usual.value,
        range: story.value ? null : usual.range,
      }
    : usual;
  const big = line.kind !== "none" && !p.small;
  const m = story?.mood ?? mood(line, ageS, hour);
  const here = line.kind === "live" && line.minutes === 0 && m.emoji === "🚐";
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-2 text-base text-ink-soft">
        {line.colour && <span aria-hidden className="size-2.5 rounded-full" style={{ background: line.colour }} />}
        {p.label}
      </p>
      <p
        key={`${line.kind}-${p.value}`}
        className={cn(
          "font-heading font-bold text-ink",
          big ? "text-[3.4rem] leading-none" : "text-2xl",
          here && "here-pop text-teal",
        )}
      >
        {p.value}
        {p.range && <span className="ml-2 text-xl font-medium text-ink-soft">({p.range})</span>}
      </p>
      <p className="text-sm text-ink-soft">{story?.context ?? contextText(line, ageS)}</p>
      <p className="mt-1 flex items-center gap-2 text-[15px] text-ink">
        <span aria-hidden className="text-lg leading-none">
          {m.emoji}
        </span>
        <span>{m.text}</span>
      </p>
      <Notices notices={line.notices} className="mt-1" />
    </div>
  );
}

function Schedule({ spot }: { spot: PublicSpot }) {
  const { rows, loops, notices } = spot.schedule;
  const manyServices = new Set(rows.map((r) => r.serviceId)).size > 1;
  const [showEarlier, setShowEarlier] = useState(false);
  const [showLater, setShowLater] = useState(false);
  const { visible, earlier, later } = scheduleWindow(rows, { showEarlier, showLater });
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
      {earlier > 0 && <MoreButton onClick={() => setShowEarlier(true)}>{`Show ${earlier} earlier`}</MoreButton>}
      {rows.length > 0 && (
        <ol className="flex flex-col">
          {visible.map((r) => (
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
      {later > 0 && <MoreButton onClick={() => setShowLater(true)}>{`Show ${later} later`}</MoreButton>}
    </section>
  );
}

function MoreButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-11 self-start px-2 text-[15px] font-medium text-ink-soft underline underline-offset-4"
    >
      {children}
    </button>
  );
}
