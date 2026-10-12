import type { LegEstimate, LegEstimateOptions, LegSample } from "../contracts";

/**
 * Learned duration of one leg (or one dwell), with the fallback ladder from SPEC §6a. Pure.
 *
 * - Only samples within the last `windowDays` (default 7) days before `now` count; newer days weigh more
 *   (linear decay by age in days: weight = windowDays − ageDays). Samples are assumed already cleaned
 *   (off-route, gaps, > 3× median, excluded days dropped upstream).
 * - Ladder: samples whose IST hour (of `at`) == hourBucket, if there are ≥ minSamples (default 5) → level
 *   `leg_hour`; else all samples in the window, if any → `leg_day`; else `baseline`:
 *   pathM ÷ baselineKmh (default 25 km/h), or baselineDwellS (default 180) when pathM is 0.
 * - medianS / p20S / p80S are weighted quantiles of durationS. Baseline: all three equal the baseline value.
 * - n = samples used at the chosen level (0 for baseline). thin = n < minSamples.
 */
export function legEstimate(samples: LegSample[], opts: LegEstimateOptions): LegEstimate {
  const { hourBucket, pathM, now, baselineKmh = 25, minSamples = 5, windowDays = 7, baselineDwellS = 180 } = opts;

  const recent = samples
    .map((s) => ({ ...s, w: windowDays - (now - s.at) / DAY_MS }))
    .filter((s) => s.at <= now && s.w > 0 && Number.isFinite(s.durationS));
  const inHour = recent.filter((s) => istHour(s.at) === hourBucket);

  const [used, level] =
    inHour.length >= minSamples ? [inHour, "leg_hour" as const] : recent.length ? [recent, "leg_day" as const] : [];
  if (!used || !level) {
    const v = pathM > 0 ? pathM / ((baselineKmh * 1000) / 3600) : baselineDwellS;
    return { medianS: v, p20S: v, p80S: v, n: 0, level: "baseline", thin: true };
  }

  used.sort((a, b) => a.durationS - b.durationS);
  const total = used.reduce((t, s) => t + s.w, 0);
  // lower weighted quantile: the first value whose cumulative weight reaches q of the total
  const q = (p: number) => {
    let cum = 0;
    for (const s of used) {
      cum += s.w;
      if (cum >= p * total * (1 - 1e-9)) return s.durationS;
    }
    return used[used.length - 1].durationS;
  };
  return { medianS: q(0.5), p20S: q(0.2), p80S: q(0.8), n: used.length, level, thin: used.length < minSamples };
}

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
const istHour = (at: number) => new Date(at + IST_OFFSET_MS).getUTCHours();
