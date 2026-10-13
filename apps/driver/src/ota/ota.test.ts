import type { Mode } from "@eci-shuttle/shared/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOta, OTA_MAX_TRIES } from "./ota";

type Opts = {
  running?: string | null;
  emergency?: boolean;
  attempted?: string | null;
  fetched?: string | null;
  mode?: Mode;
};

function setup(o: Opts = {}) {
  let mode: Mode = o.mode ?? "idle";
  let attempted = o.attempted ?? null;
  const updates = {
    updateId: o.running === undefined ? "u1" : o.running,
    isEmergencyLaunch: o.emergency ?? false,
    // the channel's latest: what checkForUpdateAsync sees and fetchUpdateAsync would download
    checkForUpdateAsync: vi.fn(async (): Promise<{ manifest?: { id: string } }> => {
      const id = o.fetched === undefined ? "u2" : o.fetched;
      return id ? { manifest: { id } } : {};
    }),
    fetchUpdateAsync: vi.fn(async (): Promise<{ manifest?: { id: string } }> => {
      const id = o.fetched === undefined ? "u2" : o.fetched;
      return id ? { manifest: { id } } : {};
    }),
    reloadAsync: vi.fn(async () => {}),
  };
  const store = {
    get: async () => attempted,
    set: async (id: string | null) => {
      attempted = id;
    },
  };
  const ota = createOta({ updates, store, getMode: () => mode });
  return {
    ota,
    updates,
    setMode: (m: Mode) => {
      mode = m;
    },
    attempted: () => attempted,
  };
}

describe("createOta (SPEC §5: server-controlled OTA)", () => {
  it("does nothing without a target or when the target already runs", async () => {
    const t = setup();
    expect(await t.ota.reconcile(null)).toBe("none");
    expect(await t.ota.reconcile("u1")).toBe("none");
    expect(t.updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it("downloads in the background and reloads while idle, remembering the attempt", async () => {
    const t = setup();
    expect(await t.ota.reconcile("u2")).toBe("apply");
    expect(t.updates.fetchUpdateAsync).toHaveBeenCalledOnce();
    expect(t.attempted()).toBe("u2");
    expect(t.updates.reloadAsync).toHaveBeenCalledOnce();
  });

  it("downloads during an active window but never reloads; applies on a later idle sync without refetching", async () => {
    const t = setup({ mode: "active" });
    expect(await t.ota.reconcile("u2")).toBe("wait");
    expect(t.updates.reloadAsync).not.toHaveBeenCalled();
    expect(t.attempted()).toBeNull();
    t.setMode("idle");
    expect(await t.ota.reconcile("u2")).toBe("apply");
    expect(t.updates.fetchUpdateAsync).toHaveBeenCalledOnce();
    expect(t.updates.reloadAsync).toHaveBeenCalledOnce();
  });

  it("re-checks the mode after the download: a window that opened meanwhile blocks the reload", async () => {
    const t = setup();
    t.updates.fetchUpdateAsync.mockImplementationOnce(async () => {
      t.setMode("active");
      return { manifest: { id: "u2" } };
    });
    expect(await t.ota.reconcile("u2")).toBe("wait");
    expect(t.updates.reloadAsync).not.toHaveBeenCalled();
  });

  it("never downloads an update that isn't the target (EAS serves the channel's latest)", async () => {
    const t = setup({ fetched: "u3" });
    expect(await t.ota.reconcile("u2")).toBe("mismatch");
    expect(t.updates.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(t.updates.reloadAsync).not.toHaveBeenCalled();
    const none = setup({ fetched: null });
    expect(await none.ota.reconcile("u2")).toBe("mismatch");
    expect(none.updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it("still refuses to apply when the channel moved between check and download", async () => {
    const t = setup();
    t.updates.fetchUpdateAsync.mockResolvedValueOnce({ manifest: { id: "u3" } });
    expect(await t.ota.reconcile("u2")).toBe("mismatch");
    expect(t.updates.reloadAsync).not.toHaveBeenCalled();
  });

  it("returns error instead of throwing when the download fails, so sync keeps going", async () => {
    const t = setup();
    t.updates.fetchUpdateAsync.mockRejectedValueOnce(new Error("offline"));
    expect(await t.ota.reconcile("u2")).toBe("error");
    expect(await t.ota.reconcile("u2")).toBe("apply");
  });

  it("forgets the attempt when the reload itself throws, so it isn't reported as a failed launch", async () => {
    const t = setup();
    t.updates.reloadAsync.mockRejectedValueOnce(new Error("no"));
    expect(await t.ota.reconcile("u2")).toBe("error");
    expect(t.attempted()).toBeNull();
    expect(await t.ota.report()).toEqual({ updateId: "u1" });
  });

  it("runs one reconcile at a time", async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.ota.reconcile("u2"), t.ota.reconcile("u2")]);
    expect([a, b]).toEqual(["apply", "busy"]);
    expect(t.updates.fetchUpdateAsync).toHaveBeenCalledOnce();
  });

  describe("targets the phone can't get (admin rollback to an id that isn't the channel's latest)", () => {
    it("reports updateFailed after OTA_MAX_TRIES mismatches and stops asking until the target changes", async () => {
      const t = setup({ fetched: "u3" });
      for (let i = 1; i < OTA_MAX_TRIES; i++) expect(await t.ota.reconcile("u2")).toBe("mismatch");
      expect(await t.ota.report()).toEqual({ updateId: "u1" });
      expect(await t.ota.reconcile("u2")).toBe("failed");
      expect(await t.ota.report()).toEqual({ updateId: "u1", updateFailed: true });
      expect(await t.ota.reconcile("u2")).toBe("failed");
      expect(t.updates.checkForUpdateAsync).toHaveBeenCalledTimes(OTA_MAX_TRIES);
      expect(t.updates.fetchUpdateAsync).not.toHaveBeenCalled();
      // admin republished u3 as the target: try again, failure cleared
      expect(await t.ota.reconcile("u3")).toBe("apply");
      expect(await t.ota.report()).toEqual({ updateId: "u1", updateFailed: true }); // the reload into u3 is pending
    });

    it("clears the failure when the server moves the target back to what runs", async () => {
      const t = setup({ fetched: "u3" });
      for (let i = 0; i < OTA_MAX_TRIES; i++) await t.ota.reconcile("u2");
      expect(await t.ota.reconcile("u1")).toBe("none");
      expect(await t.ota.report()).toEqual({ updateId: "u1" });
    });

    it("never gives up or reports updateFailed on transient errors (network, store, reload)", async () => {
      const t = setup();
      t.updates.fetchUpdateAsync.mockRejectedValue(new Error("offline"));
      for (let i = 0; i < OTA_MAX_TRIES + 1; i++) expect(await t.ota.reconcile("u2")).toBe("error");
      expect(await t.ota.report()).toEqual({ updateId: "u1" });
      t.updates.fetchUpdateAsync.mockResolvedValue({ manifest: { id: "u2" } });
      expect(await t.ota.reconcile("u2")).toBe("apply");
    });

    it("counts tries per target: a new target starts fresh", async () => {
      const t = setup({ fetched: "u4" });
      for (let i = 1; i < OTA_MAX_TRIES; i++) await t.ota.reconcile("u2");
      expect(await t.ota.reconcile("u3")).toBe("mismatch");
      expect(await t.ota.report()).toEqual({ updateId: "u1" });
    });

    it("on an emergency launch, does not chase the target until it changes", async () => {
      const t = setup({ running: null, emergency: true });
      expect(await t.ota.reconcile("u2")).toBe("failed");
      expect(t.updates.checkForUpdateAsync).not.toHaveBeenCalled();
      expect(await t.ota.report()).toEqual({ updateId: null, updateFailed: true });
      expect(await t.ota.reconcile("u3")).toBe("mismatch");
    });

    it("after an emergency launch from a reload we made, takes the admin's rollback target", async () => {
      const t = setup({ running: null, emergency: true, attempted: "u2", fetched: "u0" });
      expect(await t.ota.reconcile("u0")).toBe("apply");
      expect(t.attempted()).toBe("u0");
    });
  });

  describe("failed and emergency launches", () => {
    it("reports the running update, and no failure on a normal launch", async () => {
      expect(await setup().ota.report()).toEqual({ updateId: "u1" });
    });

    it("reports updateFailed on an emergency launch", async () => {
      expect(await setup({ running: null, emergency: true }).ota.report()).toEqual({
        updateId: null,
        updateFailed: true,
      });
    });

    it("reports updateFailed when the attempted update isn't what launched (expo-updates fell back)", async () => {
      expect(await setup({ attempted: "u2" }).ota.report()).toEqual({ updateId: "u1", updateFailed: true });
    });

    it("does not retry a target that already crashed, until the server picks another", async () => {
      const t = setup({ attempted: "u2" });
      expect(await t.ota.reconcile("u2")).toBe("failed");
      expect(t.updates.fetchUpdateAsync).not.toHaveBeenCalled();
      t.updates.checkForUpdateAsync.mockResolvedValueOnce({ manifest: { id: "u3" } });
      t.updates.fetchUpdateAsync.mockResolvedValueOnce({ manifest: { id: "u3" } });
      expect(await t.ota.reconcile("u3")).toBe("apply");
      expect(t.attempted()).toBe("u3");
    });

    it("stops reporting the failure once the server rolls back to what runs", async () => {
      const t = setup({ attempted: "u2" });
      expect(await t.ota.reconcile("u1")).toBe("none");
      expect(await t.ota.report()).toEqual({ updateId: "u1" });
    });

    it("clears the attempt once the target launched fine", async () => {
      const t = setup({ running: "u2", attempted: "u2" });
      expect(await t.ota.report()).toEqual({ updateId: "u2" });
      expect(await t.ota.reconcile("u2")).toBe("none");
      expect(t.attempted()).toBeNull();
    });
  });
});
