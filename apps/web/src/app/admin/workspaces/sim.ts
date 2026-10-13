/** Simulated phones (SPEC §3): a `pnpm sim` process paired with a code made here. */
const PREFIX = "Sim: ";

export const simLabel = (vehicle: string) => `${PREFIX}${vehicle}`;

// `pnpm sim <workspace> "<vehicle>" <pairing-code>` (scripts/sim/args.ts); the sim pairs with simulated: true.
export const simCommand = (slug: string, vehicle: string, code: string) =>
  `pnpm sim ${slug} ${JSON.stringify(vehicle)} ${code}`;

export const isSimDevice = (d: { simulated: boolean; revokedAt: Date | null }) => d.simulated && !d.revokedAt;
