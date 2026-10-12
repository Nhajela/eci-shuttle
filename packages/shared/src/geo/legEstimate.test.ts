import { describe, it } from "vitest";

describe("legEstimate", () => {
  it.todo("≥5 samples in the hour bucket → leg_hour, quantiles from those only");
  it.todo("<5 in the hour bucket but some in the window → leg_day, thin when n < 5");
  it.todo("no samples → baseline: pathM ÷ 25 km/h, n 0, thin");
  it.todo("no samples and pathM 0 (dwell) → baselineDwellS");
  it.todo("samples older than 7 days are ignored");
  it.todo("newer samples weigh more than older ones");
  it.todo("hour bucket uses IST hour of the sample (02:00 UTC is 07:30 IST → bucket 7)");
  it.todo("custom minSamples / baselineKmh / windowDays");
  it.todo("p20 ≤ median ≤ p80");
  it.todo("single sample → all three quantiles equal it");
});
