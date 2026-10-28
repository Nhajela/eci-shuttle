# fix: vans on the return half of an out-and-back route were placed on the outbound leg

## Summary

The live route is out-and-back: `spotIds = [Nanu, Riva, Circle, Namaka, Circle, Riva, Nanu]`. Riva, Circle and Nanu
appear twice. Every place that located a vehicle on the route used `indexOf` on spot ids, which always returns the
first occurrence, so on the way back every van was treated as being on the way out. Effects seen live: after leaving
Circle southbound the next stop was "Namaka"; a van that had just left Namaka (next = Circle) resolved to the leg
Riva to Circle, so Circle's answer became 0 min ("here now" territory), which fires arrival alerts and `/need` "here"
messages.

No schema change, no frozen contract edited.

## Root cause

`vehicle_state` stores `spotId`, `nextSpotId` and `alongM` (metres along the whole path), but no leg index. Callers
rebuilt the leg with `spotIds.indexOf(...)`:

- ingest wrote a wrong `nextSpotId` / `alongM` / `etaS` for the whole return half (it resolved the stop it was at
  to the first occurrence);
- public status turned `nextSpotId` into a leg with `indexOf(next, 1) - 1`, i.e. the first leg ending in that stop.

## Fix

New pure helper `packages/shared/src/geo/legOf.ts` (exported as `@eci-shuttle/shared/geo/legOf`; the geo barrel is
frozen, see contract request below):

- `legOf(route, { spotId, nextSpotId, alongM })`: leg k (spotIds[k] to spotIds[k+1]). The (spot, next spot) pair names
  the leg; if it is still ambiguous the leg whose span along the path holds `alongM`; only then the first occurrence.
  -1 when the spot is not on the route.
- `spotIndexOf(route, spotId, { nextSpotId, alongM, recent })` / `spotCandidates`: the occurrence of a stop for an
  at_spot vehicle. `recent` is the dwell history (see below).
- `spotAlongM(route)`: metres along the path at each stop.
- A loop's last spot is its first: leaving it is leg 0 again (unchanged behaviour).

Ingest cannot use the stored state to decide (it is the thing being written, and old rows may be wrong), so it uses the
vehicle's dwell log (geofence events, derived data): the last visited stops, read against the route backwards. Arriving
at Circle after Namaka matches only the second Circle; leaving it is leg 4 (next = Riva). With no history yet (first
dwell of a vehicle at a repeated stop) an en-route vehicle goes to the leg its last fix lies on; an at_spot one falls
back to the first occurrence and is corrected at the next stop.

## Call sites changed

| File | Was | Now |
|---|---|---|
| `services/ingest/ingest.ts` `routeProgress` (was :411) | `spotIds.indexOf(spotId)` | `occurrenceOf` (dwell log, then fix projection); loop end maps to leg 0; alongM projected onto the right leg |
| `services/ingest/ingest.ts` `matchDay` | any departure from `spotIds[0]` matched the timetable | a route that revisits its first stop mid-route (not as the loop end) only matches the first occurrence (dwell log) |
| `services/public/status.ts` `etaVehicle` (was :584/587) | `indexOf(spotId)`, `indexOf(next, 1) - 1` | `spotIndexOf` / `legOf` |
| `services/public/status.ts` (was :244) | timetable offset of the first occurrence only | every departing pass of the stop (a stop passed twice lists both passes) |
| `services/public/positions.ts` (was :195) | `indexOf(next, 1) - 1` | `legOf` (van drawn on the right leg, correct `legFraction`) |
| `services/subscriptions/update-text.ts` (was :169) + `updates.ts` | `routeSpotIds.indexOf(spot)` | `spotIndexOf` with the new `nextSpotId` on the `waiting` state |
| `components/public/story.ts` (was :65, :90) | `indexOf` for "your stop is next" and ride time | `spotIndexOf`; no ride time claimed to a stop only reached after the van turns round |

Checked and left alone (no first-occurrence assumption): `shared/geo/eta.ts` (already walks "the next occurrence ahead"
by leg index), learning (`learning.ts` keys legs by (from, to) pair and dwells by spot), `van-strip.tsx` (uses
`legIndex` from positions, now correct), `sight.ts`, `catalog/*`.

## Tests

- `packages/shared/src/geo/legOf.test.ts` (21): out-and-back both directions, the reported Namaka-to-Circle case, loop
  wrap (Nanu end to Nanu start), second lap, inconsistent pair, a non-repeating route behaves as `indexOf`.
- `services/ingest/ingest.repeated.db.test.ts` (3): drives two full laps of the out-and-back route with simulated
  pings; at every dwell and at 25 % / 75 % of every leg, `spotId`, `nextSpotId`, `alongM` and `etaS` are checked;
  "leaving Circle after Namaka heads for Riva"; mid-route first-stop departure is not matched to the timetable.
- `services/public/status.repeated.db.test.ts` (5): regression for the reported symptom (just left Namaka: Circle is
  1 to 3 min, not "here now"/0); an arrival alert with a 1 min lead at Circle does not fire and queues nothing; waiting
  at Circle on the way back; outbound unchanged; both passes in the timetable.
- `services/public/positions.repeated.db.test.ts` (3), `update-text.test.ts` (+1), `components/public/story.test.ts` (+3).
- Red first: each new test failed on the old code for the stated reason, then went green. New factory
  `tests/factories/repeated-stops.ts`.
- `pnpm typecheck`, `pnpm lint` (7 pre-existing warnings), full `pnpm test`: 151 files, 1427 tests pass.

## Risk notes: deploying mid-event

- No migration. Safe to roll back (the old code ignores the new helper).
- Existing `vehicle_state` rows written by the old code may have a wrong `nextSpotId` / `alongM` / `etaS` for up to one
  leg while a van is on the return half. The new ingest does not read the stored state to resolve the leg: it reads the
  dwell log (which the old code wrote correctly, since it comes from geofence events) and the latest fix, and rewrites
  the row on the next ping batch (as soon as the phone uploads). So a moving van self-corrects on its first ping
  after deploy, not at the next arrival.
- Between deploy and that first ping, the readers (status, positions) use the stored pair plus `alongM`; a stale row is
  still wrong for those seconds, as before. Stale/offline rows are not rewritten until the van reports again.
- A vehicle whose dwell log is empty or does not end at its current stop (first dwell of the day at a repeated stop, or a
  skipped stop) falls back to the fix projection (en route) or the first occurrence (at a stop). On the shared road
  of an out-and-back route the projection ties, so such a van can be on the wrong pass until its next geofence arrival.
- Behaviour change to know about: timed services now list both passes of a repeated stop (e.g. Circle appears at +offset
  of the outbound and of the return pass), where before only the outbound pass was listed.
- One extra query (last 14 dwells of the vehicle) per ingest batch, only for routes that repeat a stop.
- Learning is unchanged: legs are keyed by (from, to), so outbound and return legs were already separate.

## Contract change request

`packages/shared/src/geo/index.ts` (frozen barrel) should export `legOf`, `spotIndexOf`, `spotCandidates`,
`spotAlongM` from `./legOf`. Workaround in this PR: a `./geo/legOf` subpath in `packages/shared/package.json` exports.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01HbymRqzx9oYsp8tgK21s8z
