/**
 * Dead-zone detection (pure). Input: pings of Android phones (which record GPS offline and upload the backlog later)
 * already projected onto their route, each with how late it arrived (received_at − recorded_at). A stretch where
 * pings consistently arrive late, trip after trip and day after day, is a stretch without mobile signal.
 *
 * Thresholds (named, tuned for a ~20 km/h shuttle on a few-km route; revisit with real data):
 *  - LATE_S 90 s: a ping that arrived more than 90 s after it was recorded was recorded without signal. Normal
 *    uploads take a few seconds, a retry after a short network blip under a minute.
 *  - BIN_M 50 m: the route is cut into 50 m bins; a bin is "dark" for a trip when most of that trip's pings in it
 *    arrived late. At ≥ 1 ping/5 s every bin of a trip holds pings.
 *  - MIN_TRIPS 3 and MIN_DAYS 2: a stretch needs ≥ 3 distinct trips on ≥ 2 distinct IST days, and
 *  - MIN_DARK_SHARE 0.6: ≥ 60 % of the trips that observed a bin must have it dark, so one slow upload, one dead
 *    battery or one tunnel-less day cannot make a dead zone.
 *  - MIN_STRETCH_M 100 m: shorter than two bins is GPS jitter or a single bad upload.
 *  - MERGE_GAP_BINS 1: one lit bin between two dark ones (a lucky cell) does not split a stretch.
 *  - WHOLE_LEG_SHARE 0.9: a stretch covering ≥ 90 % of its leg is reported as the whole leg.
 *  - MAX_DEVICE_LATE_SHARE 0.5: a phone whose pings are mostly late everywhere uploads in batches by design (or
 *    has a broken uplink); it says nothing about where signal is, so its pings are ignored.
 */

export const LATE_S = 90;
export const BIN_M = 50;
export const MIN_TRIPS = 3;
export const MIN_DAYS = 2;
export const MIN_DARK_SHARE = 0.6;
export const MIN_STRETCH_M = 100;
export const MERGE_GAP_BINS = 1;
export const WHOLE_LEG_SHARE = 0.9;
export const MAX_DEVICE_LATE_SHARE = 0.5;

/** A leg's extent along the whole route path, in metres. */
export type DetectLeg = { legIndex: number; startM: number; endM: number };

export type DetectPing = {
  tripId: string;
  /** IST date of the trip */
  day: string;
  deviceId: string;
  legIndex: number;
  /** metres along the whole route path */
  alongM: number;
  /** received_at − recorded_at, seconds */
  lateS: number;
};

export type DetectedStretch = {
  legIndex: number;
  startAlongM: number;
  endAlongM: number;
  /** distinct trips / IST days that saw the stretch dark */
  trips: number;
  days: number;
};

/** Stretches of no signal per leg, in leg order then along the route. */
export function detectStretches(allPings: DetectPing[], legs: DetectLeg[]): DetectedStretch[] {
  // phones that are late everywhere say nothing about where the signal is
  const perDevice = new Map<string, { n: number; late: number }>();
  for (const p of allPings) {
    const d = perDevice.get(p.deviceId) ?? { n: 0, late: 0 };
    d.n++;
    if (p.lateS > LATE_S) d.late++;
    perDevice.set(p.deviceId, d);
  }
  const pings = allPings.filter((p) => {
    const d = perDevice.get(p.deviceId) as { n: number; late: number };
    return d.late / d.n <= MAX_DEVICE_LATE_SHARE;
  });

  const out: DetectedStretch[] = [];
  for (const leg of [...legs].sort((a, b) => a.legIndex - b.legIndex)) {
    const lengthM = leg.endM - leg.startM;
    if (lengthM <= 0) continue;
    const nBins = Math.ceil(lengthM / BIN_M);
    // trip → bin → [pings, late pings]
    const trips = new Map<string, { day: string; bins: Map<number, [number, number]> }>();
    for (const p of pings) {
      if (p.legIndex !== leg.legIndex) continue;
      const bin = Math.min(nBins - 1, Math.max(0, Math.floor((p.alongM - leg.startM) / BIN_M)));
      const t = trips.get(p.tripId) ?? trips.set(p.tripId, { day: p.day, bins: new Map() }).get(p.tripId);
      const b = t?.bins.get(bin) ?? [0, 0];
      b[0]++;
      if (p.lateS > LATE_S) b[1]++;
      t?.bins.set(bin, b);
    }
    // a bin is dark for a trip when most of its pings arrived late
    const darkIn = (t: { bins: Map<number, [number, number]> }, bin: number) => {
      const b = t.bins.get(bin);
      return b != null && b[1] * 2 > b[0];
    };
    const dark: boolean[] = [];
    for (let bin = 0; bin < nBins; bin++) {
      let seen = 0;
      let isDark = 0;
      for (const t of trips.values()) {
        if (!t.bins.has(bin)) continue;
        seen++;
        if (darkIn(t, bin)) isDark++;
      }
      dark.push(seen >= MIN_TRIPS && isDark / seen >= MIN_DARK_SHARE);
    }

    // runs of dark bins, bridging up to MERGE_GAP_BINS lit ones
    const runs: [number, number][] = [];
    for (let bin = 0; bin < nBins; bin++) {
      if (!dark[bin]) continue;
      const last = runs.at(-1);
      if (last && bin - last[1] - 1 <= MERGE_GAP_BINS) last[1] = bin;
      else runs.push([bin, bin]);
    }
    for (const [first, last] of runs) {
      const startAlongM = leg.startM + first * BIN_M;
      const endAlongM = Math.min(leg.endM, leg.startM + (last + 1) * BIN_M);
      if (endAlongM - startAlongM < MIN_STRETCH_M) continue;
      // trips that saw at least half of the stretch's observed bins dark
      const seers = [...trips.values()].filter((t) => {
        let seen = 0;
        let isDark = 0;
        for (let bin = first; bin <= last; bin++) {
          if (!t.bins.has(bin)) continue;
          seen++;
          if (darkIn(t, bin)) isDark++;
        }
        return seen > 0 && isDark * 2 >= seen;
      });
      const days = new Set(seers.map((t) => t.day)).size;
      if (seers.length < MIN_TRIPS || days < MIN_DAYS) continue;
      const whole = (endAlongM - startAlongM) / lengthM >= WHOLE_LEG_SHARE;
      out.push({
        legIndex: leg.legIndex,
        startAlongM: whole ? leg.startM : startAlongM,
        endAlongM: whole ? leg.endM : endAlongM,
        trips: seers.length,
        days,
      });
    }
  }
  return out;
}
