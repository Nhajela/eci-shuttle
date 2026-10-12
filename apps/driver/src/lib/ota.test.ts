import { describe, expect, it } from "vitest";
import { otaStep } from "./ota";

const base = { targetUpdateId: "u2", runningUpdateId: "u1", downloadedUpdateId: null, mode: "idle" as const };

describe("otaStep (SPEC §5: server-controlled OTA, apply only while idle)", () => {
  it("does nothing when the server sets no target", () => {
    expect(otaStep({ ...base, targetUpdateId: null })).toBe("none");
  });

  it("does nothing when the target is already running", () => {
    expect(otaStep({ ...base, targetUpdateId: "u1" })).toBe("none");
  });

  it("downloads a new target in the background, even while active", () => {
    expect(otaStep({ ...base, mode: "active" })).toBe("download");
    expect(otaStep(base)).toBe("download");
  });

  it("re-downloads when the target changed after a previous download", () => {
    expect(otaStep({ ...base, downloadedUpdateId: "u3" })).toBe("download");
  });

  it("applies a downloaded target while idle", () => {
    expect(otaStep({ ...base, downloadedUpdateId: "u2" })).toBe("apply");
  });

  it("never applies during an active window", () => {
    expect(otaStep({ ...base, downloadedUpdateId: "u2", mode: "active" })).toBe("wait");
  });

  it("applies when killed or unpaired, since nothing is tracking", () => {
    expect(otaStep({ ...base, downloadedUpdateId: "u2", mode: "killed" })).toBe("apply");
    expect(otaStep({ ...base, downloadedUpdateId: "u2", mode: "unpaired" })).toBe("apply");
  });

  it("treats the embedded bundle (null running id) as different from any target", () => {
    expect(otaStep({ ...base, runningUpdateId: null })).toBe("download");
  });
});
