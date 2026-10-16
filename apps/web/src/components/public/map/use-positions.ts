"use client";
/**
 * Polls GET /api/positions every 10 s while the tab is visible, and at once when the page is back in view
 * (resume.watchResume). Null until the first answer; keeps the last good one; an older answer never replaces a newer.
 */
import { useEffect, useState } from "react";
import type { PublicMap } from "@/services/public/positions";
import { browserTargets, latestOnly, watchResume } from "../resume";

const POLL_MS = 10_000;

export function usePositions(slug: string | null, enabled = true): PublicMap | null {
  const [data, setData] = useState<PublicMap | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const url = slug ? `/api/positions?w=${encodeURIComponent(slug)}` : "/api/positions";
    const gate = latestOnly();
    const load = async () => {
      if (document.hidden) return;
      try {
        await gate.run(
          async () => {
            const res = await fetch(url, { cache: "no-store" });
            if (!res.ok) throw new Error(String(res.status));
            return (await res.json()) as PublicMap;
          },
          (next) => {
            if (alive) setData(next);
          },
        );
      } catch {
        // keep the last answer; the page says when the server is unreachable
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    const stopWatching = watchResume({ ...browserTargets(), onResume: load });
    return () => {
      alive = false;
      clearInterval(t);
      stopWatching();
    };
  }, [slug, enabled]);
  return data;
}
