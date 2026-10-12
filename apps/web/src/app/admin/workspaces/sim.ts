/** Simulated phones (SPEC §3): a `pnpm sim` process paired with a code made here. */
const PREFIX = "Sim: ";

export const simLabel = (vehicle: string) => `${PREFIX}${vehicle}`;

export const simCommand = (slug: string, vehicle: string, code: string) =>
  `pnpm sim ${slug} ${JSON.stringify(vehicle)} ${code}`;

// ponytail: pairing can't set devices.simulated yet (no field in PairRequest), so the code's label marks a sim too.
export const isSimDevice = (d: { simulated: boolean; label: string; revokedAt: Date | null }) =>
  !d.revokedAt && (d.simulated || d.label.startsWith(PREFIX));
