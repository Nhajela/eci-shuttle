import { describe, expect, it } from "vitest";
import { isSimDevice, simCommand, simLabel } from "./sim";

describe("sim helpers", () => {
  it("labels a sim pairing code after its vehicle", () => {
    expect(simLabel("Bus 1")).toBe("Sim: Bus 1");
  });

  it("builds the command, quoting the vehicle name", () => {
    expect(simCommand("test", "Bus 1", "123456")).toBe('pnpm sim test "Bus 1" 123456');
    expect(simCommand("test", 'Say "hi"', "1")).toBe('pnpm sim test "Say \\"hi\\"" 1');
  });

  it("treats simulated devices and sim-labelled ones as sims, not revoked ones", () => {
    expect(isSimDevice({ simulated: true, label: "x", revokedAt: null })).toBe(true);
    expect(isSimDevice({ simulated: false, label: "Sim: Bus 1", revokedAt: null })).toBe(true);
    expect(isSimDevice({ simulated: false, label: "Ravi's phone", revokedAt: null })).toBe(false);
    expect(isSimDevice({ simulated: true, label: "x", revokedAt: new Date() })).toBe(false);
  });
});
