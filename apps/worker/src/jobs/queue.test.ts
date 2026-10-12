import { describe, expect, it } from "vitest";
import { backoffMs, Pacer } from "./queue";

describe("backoffMs", () => {
  it("doubles from 5 s and caps at 10 min", () => {
    expect(backoffMs(0)).toBe(5_000);
    expect(backoffMs(1)).toBe(10_000);
    expect(backoffMs(3)).toBe(40_000);
    expect(backoffMs(7)).toBe(600_000);
    expect(backoffMs(20)).toBe(600_000);
  });
});

describe("Pacer", () => {
  it("allows one send per chat per second", () => {
    const p = new Pacer();
    expect(p.chatReady(1, 0)).toBe(true);
    p.record(1, 0);
    expect(p.chatReady(1, 999)).toBe(false);
    expect(p.chatReady(2, 999)).toBe(true);
    expect(p.chatReady(1, 1000)).toBe(true);
  });

  it("caps sends overall at 25 per second and says how long to wait", () => {
    const p = new Pacer();
    for (let i = 0; i < 25; i++) {
      expect(p.globalWaitMs(i * 10)).toBe(0);
      p.record(i, i * 10);
    }
    expect(p.globalWaitMs(300)).toBe(700);
    expect(p.globalWaitMs(1000)).toBe(0);
  });
});
