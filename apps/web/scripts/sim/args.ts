import { parseArgs } from "node:util";

export const USAGE =
  'Usage: pnpm sim <workspace-slug> "<vehicle name>" <pairing-code> [--speed N] [--origin URL] [--route "<route name>"]';

export type SimArgs = {
  slug: string;
  vehicle: string;
  code: string;
  /** replay speed: 10 = the vehicle covers the route 10x faster in real time */
  speed: number;
  /** server to talk to; null = PUBLIC_ORIGIN */
  origin: string | null;
  /** route name; null = the first route of the workspace */
  route: string | null;
};

export function parseSimArgs(argv: string[]): SimArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { speed: { type: "string" }, origin: { type: "string" }, route: { type: "string" } },
  });
  const [slug, vehicle, code] = positionals;
  if (!slug || !vehicle || !code) throw new Error(USAGE);
  const speed = Number(values.speed ?? 1);
  if (!Number.isFinite(speed) || speed <= 0 || speed > 1000)
    throw new Error(`--speed must be a number above 0 (got ${values.speed}).`);
  return {
    slug,
    vehicle,
    code,
    speed,
    origin: values.origin ? values.origin.replace(/\/+$/, "") : null,
    route: values.route ?? null,
  };
}
