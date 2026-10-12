/** Simulated phones (SPEC §3): a `pnpm sim` process paired with a code made here. */
const PREFIX = "Sim: ";

export const simLabel = (vehicle: string) => `${PREFIX}${vehicle}`;

// ponytail: pending contract. SPEC §3 and scripts/sim.ts only document `pnpm sim <workspace> <vehicle>`; the
// third <pairing-code> argument waits on CONTRACTS.md (contract request). Change here if the sim takes it another way.
export const simCommand = (slug: string, vehicle: string, code: string) =>
  `pnpm sim ${slug} ${JSON.stringify(vehicle)} ${code}`;

// ponytail: pairing can't set devices.simulated yet (no `simulated` on PairingCodeCreateFields / pairing_codes), so
// sims pair with simulated=false and the "Sim: " label is the only mark. Known gaps until the contract lands: the
// movePhoneToWorkspace live guard won't fire for these sims, and a real phone labelled "Sim: ..." shows here.
// Then: pass `simulated: true` in startSimAction and make this `d.simulated && !d.revokedAt`.
export const isSimDevice = (d: { simulated: boolean; label: string; revokedAt: Date | null }) =>
  !d.revokedAt && (d.simulated || d.label.startsWith(PREFIX));
