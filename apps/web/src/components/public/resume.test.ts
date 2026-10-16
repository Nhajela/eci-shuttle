import { describe, expect, it, vi } from "vitest";
import { latestOnly, watchResume } from "./resume";

function world() {
  const doc = new EventTarget();
  const win = new EventTarget();
  let hidden = false;
  let t = 0;
  return {
    doc,
    win,
    setHidden: (h: boolean) => {
      hidden = h;
    },
    tick: (ms: number) => {
      t += ms;
    },
    opts: { doc, win, isHidden: () => hidden, now: () => t },
  };
}

describe("watchResume: refresh the moment the page is back", () => {
  it("fires on becoming visible, focus, back/forward-cache restore and reconnect, once per burst", () => {
    const w = world();
    const cb = vi.fn();
    const stop = watchResume({ ...w.opts, onResume: cb });
    w.doc.dispatchEvent(new Event("visibilitychange"));
    w.win.dispatchEvent(new Event("focus")); // same burst: once
    expect(cb).toHaveBeenCalledTimes(1);
    w.tick(5000);
    w.win.dispatchEvent(new Event("pageshow"));
    w.tick(5000);
    w.win.dispatchEvent(new Event("online"));
    expect(cb).toHaveBeenCalledTimes(3);
    stop();
    w.tick(5000);
    w.win.dispatchEvent(new Event("focus"));
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("never while the page is hidden", () => {
    const w = world();
    const cb = vi.fn();
    watchResume({ ...w.opts, onResume: cb });
    w.setHidden(true);
    w.doc.dispatchEvent(new Event("visibilitychange"));
    w.win.dispatchEvent(new Event("online"));
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("latestOnly: an older answer never replaces a newer one", () => {
  it("drops a response that started before the latest one applied", async () => {
    const applied: string[] = [];
    const gate = latestOnly();
    let releaseSlow: (v: string) => void = () => {};
    const slow = gate.run(
      () => new Promise<string>((r) => (releaseSlow = r)),
      (v) => applied.push(v),
    );
    const fast = gate.run(
      async () => "new",
      (v) => applied.push(v),
    );
    await fast;
    releaseSlow("old");
    await slow;
    expect(applied).toEqual(["new"]);
  });
});
