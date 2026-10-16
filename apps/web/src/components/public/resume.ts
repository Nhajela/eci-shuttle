/**
 * Keeping the attendee page fresh on phones: a tab left in the background (or restored from the back/forward cache,
 * or back online) must refresh the moment it is looked at again, not show times from when it was put away.
 */

type Targets = {
  doc: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  win: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  isHidden: () => boolean;
  now: () => number;
};

/** events that fire together when a page comes back count once within this window */
const BURST_MS = 1000;

/**
 * Calls `onResume` when the page is back in view: visible again, window focus, a back/forward-cache restore
 * (`pageshow`, where iOS fires no visibilitychange) or the network returning. Once per burst; never while hidden.
 * Returns the unsubscribe.
 */
export function watchResume({ doc, win, isHidden, now, onResume }: Targets & { onResume: () => void }): () => void {
  let last = Number.NEGATIVE_INFINITY;
  const fire = () => {
    if (isHidden()) return;
    const t = now();
    if (t - last < BURST_MS) return;
    last = t;
    onResume();
  };
  doc.addEventListener("visibilitychange", fire);
  for (const e of ["focus", "pageshow", "online"]) win.addEventListener(e, fire);
  return () => {
    doc.removeEventListener("visibilitychange", fire);
    for (const e of ["focus", "pageshow", "online"]) win.removeEventListener(e, fire);
  };
}

/** The browser's own document and window. */
export const browserTargets = (): Targets => ({
  doc: document,
  win: window,
  isHidden: () => document.hidden,
  now: () => Date.now(),
});

/**
 * Applies only the newest request's answer: when a resume refresh and a timer poll overlap, a slow older response
 * arriving last must not put older times back on screen.
 */
export function latestOnly() {
  let started = 0;
  let applied = 0;
  return {
    async run<T>(load: () => Promise<T>, apply: (value: T) => void): Promise<void> {
      const id = ++started;
      const value = await load();
      if (id < applied) return;
      applied = id;
      apply(value);
    },
  };
}
