"use client";

import { Loader2, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type Phase = "idle" | "starting" | "pending" | "expired" | "error";

const STORE_KEY = "shuttle-login";
const POLL_MS = 2000;
/** = services/auth/codes LOGIN_CODE_TTL_MS (not imported: that module is server-only) */
const TTL_MS = 10 * 60_000;
const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "";

const forget = () => {
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {}
};

/**
 * Telegram login (ported from Travel CoOp): start → open the t.me deep link → poll until the bot confirms, then
 * go to `next`. Remembers an in-flight attempt in sessionStorage, so coming back from Telegram (which may reload
 * the page) resumes the wait.
 */
export function LoginButton({ next = "/admin", label = "Log in with Telegram" }: { next?: string; label?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState<string | null>(null);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const poll = useCallback(() => {
    stop();
    timer.current = setInterval(async () => {
      if (Date.now() - startedAt.current > TTL_MS) {
        stop();
        forget();
        setPhase("expired");
        return;
      }
      try {
        const res = await fetch("/api/auth/poll", { cache: "no-store" });
        const { status } = (await res.json()) as { status: "pending" | "ok" | "expired" };
        if (status === "pending") return;
        stop();
        forget();
        if (status === "ok") window.location.assign(next);
        else setPhase("expired");
      } catch {
        // a network blip: keep polling
      }
    }, POLL_MS);
  }, [next, stop]);

  // Resume a pending attempt after a reload (e.g. back from Telegram's in-app browser).
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "null") as { url: string; at: number } | null;
      if (saved && Date.now() - saved.at < TTL_MS) {
        startedAt.current = saved.at;
        setUrl(saved.url);
        setPhase("pending");
        poll();
      } else forget();
    } catch {}
    return stop;
  }, [poll, stop]);

  const start = async () => {
    setPhase("starting");
    try {
      const res = await fetch("/api/auth/start", { method: "POST" });
      if (!res.ok) throw new Error("start failed");
      const { url: u } = (await res.json()) as { url: string };
      startedAt.current = Date.now();
      setUrl(u);
      try {
        sessionStorage.setItem(STORE_KEY, JSON.stringify({ url: u, at: startedAt.current }));
      } catch {}
      setPhase("pending");
      poll();
      // window.open is often blocked in Telegram's in-app browser: fall back to navigating
      if (!window.open(u, "_blank", "noopener")) window.location.href = u;
    } catch {
      setPhase("error");
    }
  };

  const cancel = () => {
    stop();
    forget();
    setPhase("idle");
    setUrl(null);
  };

  if (phase === "pending" && url)
    return (
      <div className="flex flex-col gap-3">
        <div role="status" className="flex items-start gap-3 rounded-2xl bg-muted p-4 text-[15px] leading-6">
          <span className="relative mt-2 flex size-2.5 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
          </span>
          <span>
            <strong className="font-semibold">Tap Start in Telegram, then come back here.</strong>
            <br />
            This page updates by itself.
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="lg" variant="outline" render={<a href={url} target="_blank" rel="noopener" />}>
            <Send data-icon="inline-start" />
            Open Telegram again
          </Button>
          <Button size="lg" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <Button
        size="lg"
        className="w-full"
        onClick={start}
        disabled={phase === "starting"}
        aria-busy={phase === "starting"}
      >
        {phase === "starting" ? (
          <Loader2 className="animate-spin" data-icon="inline-start" />
        ) : (
          <Send data-icon="inline-start" />
        )}
        {phase === "starting" ? "Opening Telegram…" : label}
      </Button>
      {phase === "expired" && <p className="text-[14px] text-muted-foreground">That login expired. Try once more?</p>}
      {phase === "error" && <p className="text-[14px] text-destructive">Couldn&rsquo;t start the login. Try again.</p>}
      {BOT && (
        <p className="text-[14px] leading-5 text-muted-foreground">
          Or message{" "}
          <a
            href={`https://t.me/${BOT}`}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2"
          >
            @{BOT}
          </a>{" "}
          and it sends you a login link.
        </p>
      )}
    </div>
  );
}
