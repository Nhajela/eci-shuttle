import type { LegEstimate, LegEstimateOptions, LegSample } from "../contracts";
import { notImplemented } from "../notImplemented";

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
  return notImplemented(samples, opts);
}
