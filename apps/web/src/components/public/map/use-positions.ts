"use client";
/** Polls GET /api/positions every 10 s while the tab is visible. Null until the first answer; keeps the last good one. */
import { useEffect, useState } from "react";
import type { PublicMap } from "@/services/public/positions";

const POLL_MS = 10_000;

export function usePositions(slug: string | null, enabled = true): PublicMap | null {
  const [data, setData] = useState<PublicMap | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const url = slug ? `/api/positions?w=${encodeURIComponent(slug)}` : "/api/positions";
    const load = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as PublicMap;
        if (alive) setData(next);
      } catch {
        // keep the last answer; the page says when the server is unreachable
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug, enabled]);
  return data;
}
