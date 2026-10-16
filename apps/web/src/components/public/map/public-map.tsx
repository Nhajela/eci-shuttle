"use client";
/**
 * The map card on the attendee page: lazy-loads the WebGL map (live-map.tsx) only in the browser, so the answer
 * above renders first; shows the painted scene underneath until the map is ready; if WebGL or the tiles fail it
 * quietly shows nothing but a one-liner. Follow-the-shuttle and full-screen toggles live here.
 */
import { cn } from "cn";
import { Expand, LocateFixed, Minimize2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { PublicMap as Data } from "@/services/public/positions";

const LiveMap = dynamic(() => import("./live-map").then((m) => m.LiveMap), { ssr: false });

function useMedia(query: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const mq = matchMedia(query);
    setOn(mq.matches);
    const h = () => setOn(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [query]);
  return on;
}

/** The painted van while the tiles are on their way, and when the map cannot run here. */
function Placeholder({ sprite, caption }: { sprite: string | null; caption: string | null }) {
  return (
    <div className="map-sky absolute inset-0 flex flex-col items-center justify-center gap-2" aria-hidden>
      {sprite && (
        // biome-ignore lint/performance/noImgElement: static webp straight from /public
        <img
          src={sprite}
          alt=""
          className="scene-van w-[58%] max-w-[300px] drop-shadow-[0_14px_18px_rgba(20,27,52,0.25)]"
        />
      )}
      {caption && <p className="text-sm font-medium text-ink-soft">{caption}</p>}
    </div>
  );
}

export function PublicMapCard({
  data,
  sprite = null,
  className,
}: {
  data: Data | null;
  /** the painted van (illustrations/scene/van.webp) for the placeholder, when it exists */
  sprite?: string | null;
  className?: string;
}) {
  const dark = useMedia("(prefers-color-scheme: dark)");
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // following the shuttle is the default; moving the map by hand stops it, the button brings it back
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState(false);
  // start the map only once the browser is idle, after the answer has painted
  const [mount, setMount] = useState(false);
  useEffect(() => {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    const t = idle ? idle(() => setMount(true), { timeout: 1500 }) : window.setTimeout(() => setMount(true), 300);
    return () => {
      if (!idle) clearTimeout(t);
    };
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [expanded]);

  if (failed)
    return (
      <div className={cn("relative h-56 overflow-hidden rounded-card", className)}>
        <Placeholder
          sprite={sprite}
          caption="The map is having a nap on this device. The answer above is still live."
        />
      </div>
    );
  if (!data)
    return (
      <div className={cn("relative h-80 overflow-hidden rounded-card lg:h-full", className)}>
        <Placeholder sprite={sprite} caption="Finding the shuttle…" />
      </div>
    );
  const vans = data.vehicles.length;

  return (
    <div
      className={cn(
        "relative overflow-hidden bg-sand",
        expanded ? "fixed inset-0 z-50 rounded-none" : cn("h-80 rounded-card lg:h-full", className),
      )}
    >
      {!ready && <Placeholder sprite={sprite} caption="Finding the shuttle…" />}
      {mount && (
        <LiveMap
          data={data}
          dark={dark}
          reducedMotion={reducedMotion}
          follow={follow}
          expanded={expanded}
          onUserMove={() => setFollow(false)}
          onReady={() => setReady(true)}
          onFail={() => setFailed(true)}
          className={cn("absolute inset-0 transition-opacity duration-700", ready ? "opacity-100" : "opacity-0")}
        />
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2">
        <span className="pointer-events-auto rounded-full bg-paper/85 px-3 py-1.5 text-xs font-semibold text-ink shadow-sm backdrop-blur">
          {vans === 0
            ? "No shuttle on the road right now"
            : vans === 1
              ? "1 shuttle on the road"
              : `${vans} shuttles on the road`}
        </span>
        <div className="pointer-events-auto flex gap-1.5">
          <button
            type="button"
            aria-pressed={follow}
            disabled={vans === 0}
            onClick={() => setFollow((f) => !f)}
            className={cn(
              "inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-xs font-semibold shadow-sm backdrop-blur disabled:opacity-50",
              follow ? "bg-ink text-paper" : "bg-paper/85 text-ink",
            )}
          >
            <LocateFixed className="size-4" aria-hidden />
            Follow
          </button>
          <button
            type="button"
            aria-label={expanded ? "Close full-screen map" : "Full-screen map"}
            onClick={() => setExpanded((e) => !e)}
            className="inline-flex size-11 items-center justify-center rounded-full bg-paper/85 text-ink shadow-sm backdrop-blur"
          >
            {expanded ? <Minimize2 className="size-4" aria-hidden /> : <Expand className="size-4" aria-hidden />}
          </button>
        </div>
      </div>
    </div>
  );
}
