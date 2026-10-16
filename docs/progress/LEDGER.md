# Progress ledger

Maintained by the orchestrator when it merges a task branch. Task agents never edit this file: they report in
their task result (summary, tests, contract requests, follow-ups).

Status: `todo` · `running` · `merged` · `blocked`

Wave 2 integration (2026-10-13): `main` was fast-forwarded to `task/contracts`, then every task below was merged
`--no-ff` in order. Where a review/fix branch existed, its tip was merged (it contains the task branch), marked
"+fix". Gates on `main` after integration: `pnpm test` (unit + db), driver `vitest`, `pnpm typecheck`,
`pnpm lint`, `pnpm --filter @eci-shuttle/web build`, worker build: all green.

| Key | Status | Notes |
|---|---|---|
| contracts | merged | Foundation: shared contracts + IST helpers, schema, kernel, service stubs, health, worker frame, placeholders, Dockerfile, CLAUDE.md, CONTRACTS.md |
| geo-path | merged | `distanceM` now replaces 4 local haversines (geofence, spots, admin spots, sim) |
| geo-geofence | merged | |
| geo-eta | merged | |
| geo-leg | merged | |
| geo-wait | merged | `headwaysFromDepartures` now in the geo barrel |
| sched-departures | merged | |
| sched-windows | merged | `applyDirectives`, `VehicleDirective` now in the schedule barrel |
| sched-mode | merged | `notificationText` now in the schedule barrel |
| sched-match | merged | |
| svc-workspaces | merged | + `listAllWorkspaces(db)` added at integration |
| svc-spots | merged | |
| svc-routes | merged | +fix (loop ends pinned; typicalLegS cleared on stop change) |
| svc-vehicles | merged | |
| svc-schedule | merged | overlap rule documented in CONTRACTS; no DB exclusion constraint (row lock instead) |
| svc-people | merged | +fix (one holder per username) |
| svc-pairing | merged | +fix (throttle failed pairs) |
| svc-phones | merged | |
| svc-config | merged | |
| svc-sync | merged | arrival alerts run from the `arrival-alerts` job, not from sync |
| svc-push | merged | |
| svc-ota | merged | |
| svc-ingest | merged | +fix. Live ETA now uses `learning.loadEstimates` |
| svc-learning | merged | |
| svc-insights | merged | list/dismiss/excludeDay added at integration; accept by accept-suggestion (wave 2b) |
| svc-notices | merged | +fix (refuse editing a notice that is over) |
| svc-public | merged | now on shared IST helpers |
| driver-scaffold | merged | +fix (otaStep stops after an unreachable fetch; EAS project id) |
| driver-store | merged | |
| driver-sync | merged | |
| driver-location | merged | |
| driver-push | merged | |
| driver-ota | merged | +fix. Passes `lastAttemptedTargetId: null` (tracks the mismatch itself) |
| driver-screens | merged | copies of store/kv/sync removed; screens use `store/native`'s one device store |
| auth-login | merged | +fix. Its `seal.ts`/`oauth.ts` were replaced by mcp-core's (same API) |
| bot-core | merged | built only the webhook adapter; handle/start/deliver came in wave 2b |
| bot-admin | merged | |
| bot-attendee | merged | built `subscriptions/*` too |
| alerts | merged | |
| activity | merged | +fix (secrets hidden from every reader; IST diff times) |
| mcp-core | merged | +fix. Owns `auth/seal`, `auth/oauth`, `mcp/tokens` |
| mcp-read | merged | +fix (IST datetimes). Registered on the server at wave 2b; `shuttle_status` uses `liveBoard` |
| mcp-propose | merged | tools registered on the server at wave 2b (were built but not in `TOOL_GROUPS`) |
| api-device | merged | rate limit is in-process (one container) |
| public-ui | merged | +fix (stale minutes hidden; 390px toggle). `/` is force-dynamic |
| admin-shell | merged | |
| admin-live | merged | +fix |
| admin-phones | merged | |
| admin-vehicles | merged | +fix. Trip stopgap replaced by `vehicles.listVehicleTrips` (wave 2b) |
| admin-people | merged | +fix |
| admin-workspaces | merged | +fix (doc). Sims recognised by `devices.simulated` (wave 2b) |
| admin-spots | merged | |
| admin-routes | merged | +fix |
| admin-schedule | merged | +fix |
| admin-notices | merged | +fix. Keeps a client copy of `compareNotices` (server module pulls in the DB) |
| admin-insights | merged | +fix. Accept works since wave 2b |
| admin-activity | merged | |
| job-watchdog | merged | |
| job-windows | merged | uses `listAllWorkspaces`, `trackedDevices` (wave 2b) |
| job-arrival | merged | |
| job-notices | merged | |
| job-queue | merged | honours `retryAfterMs` (wave 2b) |
| job-nightly | merged | uses `listAllWorkspaces`; calls `cleanup.runCleanup` (wave 2b) |
| sim | merged | |

## Wave 2b (2026-10-13)

Merged `--no-ff` onto `main` in this order (schema-2 had already landed). "+fix" = a fix branch stacked on the task
branch; its tip was merged. Conflict: `scripts/sim/plan.ts` (schema-2 and svc-routes-2 both widened
`typicalLegS`), kept main's version. Gates after integration: `pnpm test` (117 files, 1031 tests), `pnpm test:e2e`,
driver `vitest` (170) + `tsc`, `pnpm typecheck`, `pnpm lint` (6 warnings, non-null assertions in tests),
web build, worker build: all green.

| Key | Status | Notes |
|---|---|---|
| schema-2 | merged | since-columns, `planned_dwell_s`, null-safe `typical_leg_s`, `PairRequest.simulated` |
| bot-handle | merged | `handleUpdate`, `handleCallback`. Uses `spots.isSpotName` since integration |
| bot-start | merged | `/start` login claim, `/login` magic link, `/shuttle` intro |
| bot-deliver | merged | message log, 429 `retryAfterMs`, blocked users, `lib/telegram/html.escapeHtml` |
| mcp-changes | merged | (incl. its review fix) `applyChange`, versions, describe, warnings, `actorFor`, `liveBoard` |
| driver-runtime | merged | (incl. its review fix) Composition root; `apps/driver` `main` is now `index.ts` (outside deps-only exception, accepted) |
| e2e-sim | merged | `pnpm test:e2e` (local Postgres) |
| svc-schedule-2 | merged | `listServices`, `getService` |
| svc-vehicles-2 | merged | `listVehicleTrips` |
| svc-spots-2 | merged | `isSpotName` |
| svc-routes-2 | merged | (incl. its review fix) `legSamples` on `listRoutes` (shown on admin Routes since integration) |
| svc-cleanup | merged | +fix (work was on the stacked branch). `cleanup.runCleanup`; worker job only calls it |
| auth-next | merged | `requireAdmin({ next })`, `x-pathname` proxy |
| admin-shared | merged | +fix. Shared `AdminMap` (list fallback, Leaflet retry) and `ConfirmButton` |
| alerts-2 | merged | since-columns for phone episodes; `update_pending` problem, gated by the `update_failed` pref |
| ingest-2 | merged | (incl. its review fix) `off_route_since`; live ETA falls back to the route's planned dwell |
| phones-2 | merged | (incl. its review fix) `getPhone`, `getVehiclePhone`, `trackedDevices`, `PhoneHealth.silent` (admin Phones uses it) |
| pairing-2 | merged | simulated pairs stored, refused in the live workspace; sim pairs as simulated |
| accept-suggestion | merged | (incl. its review fix) `acceptSuggestion`; an accept whose proposal expired unconfirmed lists as open again |

Wired at integration: MCP read + propose/confirm tool groups registered (they were unreachable); `McpChange`
service kind as `serviceKind`; `DeliveryResult.retryAfterMs` (kernel) + queue; local escapers → `escapeHtml`;
admin Notices on `listServices`; admin Vehicles on `listVehicleTrips` (stopgap deleted); admin Routes shows
leg sample counts; admin Phones uses `PhoneHealth.silent`; sims detected by `devices.simulated` only;
listRoutes' NaN workaround removed (schema reads nulls now); driver `Fix` exported from `location/plan`.

## Lens review round 1 (2026-10-13)

Merged `--no-ff` onto `main`: w2/lens1-0 … lens1-4 (no stacked fix branches, no conflicts). Gates after
integration: `pnpm test` (118 files, 1046 tests), driver `vitest` (170) + `tsc`, `pnpm typecheck`, `pnpm lint`
(same 6 test warnings), web build, worker build: all green. Nothing needed wiring (no stubs replaced).
Then merged `origin/main` (deploy bootstrap: drizzle migrations, Expo/Firebase link, `appVersion` runtime policy);
the driver app.config test now expects `appVersion`, Biome ignores the generated `google-services.json` and
`drizzle/meta`. Its EAS-project-id guard test is skipped now that the project id is set.

| Key | Status | Notes |
|---|---|---|
| lens1-0 | merged | config windows keep their real start (silent/mode_mismatch mid-service); deep-link login asks to confirm (`login:<code>` button) before claiming; ingest drops off-duty positions, scopes assignments to the workspace, prefers special services; public ETAs only count vehicles on the resolved service; `/setgroup` sets the workspace's Telegram group, MCP warns on group notices without one |
| lens1-1 | merged | cross-midnight gap departures stay on the service date in `trackingWindows` |
| lens1-2 | merged | Bricolage Grotesque via `next/font` (`--font-bricolage` defined; var() has a fallback) |
| lens1-3 | merged | admin map isolated under the tab bar; log out from More sheet + desktop sidebar; off-route live line never reads "No more today" |
| lens1-4 | merged | sim sleeps by the config the sync just returned |

## Fix round (2026-10-13)

Merged `--no-ff` onto `main`: fx/mcp-ota, fx/health, fx/missed-deps, fx/ota-fail, fx/phone-mismatch, fx/playwright-390
(no conflicts). Gates: `pnpm test` (122 files, 1077 tests), driver `vitest` (176 + 1 skipped) + `tsc`,
`pnpm typecheck`, `pnpm lint` (same 6 test warnings), web build: all green. `pnpm test:ui` not run at integration.

| Key | Status | Notes |
|---|---|---|
| fx/mcp-ota | merged | MCP `ota.rollout` / `ota.rollback` / `ota.phone` change kinds (admin), target shown in phones/initialize |
| fx/health | merged | `HOSTNAME=::` dual-stack listen; `/api/health?live=1` liveness for Coolify's container check |
| fx/missed-deps | merged | ingest marks only staffed departures `missed` |
| fx/ota-fail | merged | driver reports `updateFailed` after 3 mismatches; transient errors retry; rollback applies after emergency launch (JS-only, needs OTA publish) |
| fx/phone-mismatch | merged | `PhoneHealth.modeMismatch` uses the watchdog's grace rule |
| fx/playwright-390 | merged | `pnpm test:ui`: 390×844 layout checks for 13 admin + public pages |

## Remaining gaps

- The workspace Telegram group can only be set with `/setgroup` in the group; admin Workspaces has no field for it.

- `AlertKind` has no `update_pending`: it is gated by the `update_failed` pref (alerts-2). Adding it needs a
  decision for existing `alert_prefs` rows (otherwise those admins silently stop getting it).
- Webhook update dedupe is in-process (`app/api/telegram/route.ts`); a `telegram_updates(update_id pk)` table
  would make it survive restarts (bot-handle).
- `learning.ts` uses a fixed `PLANNED_DWELL_S = 180` for `dwell_mismatch` and `loadEstimates`' baseline; it could
  read `routes.planned_dwell_s`, letting ingest drop its own fallback (ingest-2).
- Bot phone/service buttons still read the row by id directly to learn its workspace before building the Actor
  (an Actor is per workspace, so `getPhone`/`getService` can't be called first).
- `mcp/proposals.confirm` could stamp the suggestion behind a proposal, so "accepted" means confirmed
  (today it means proposed; expiry is handled by allowing re-accept).
- e2e phone pairs like a real phone (no `simulated`), by design of that test.
- No admin UI for `routes.planned_dwell_s` yet (defaults to `{}`; ingest falls back to learned/none).

## Contract change requests

Applied at integration: barrel exports (geo-wait, sched-windows, sched-mode); `listAllWorkspaces` (job-windows,
job-nightly); `.vitest/` ignored (api-device); `arrive` leadMin documented (bot-attendee); ownership table,
`/login/denied`, `shuttle_login`, hex `token_hash`, `sho_` prefix, `PublicToken`, subscription audit actions,
schedule overlap rule, `loadEstimates` hour param documented in CONTRACTS.md; local haversines / IST helpers /
test stand-ins swapped for the merged real functions.

Applied with owner approval (delight-bot, 2026-10-16):
- `kernel/outbox.TelegramPayload.animation?: string` (bot-core): a GIF URL under `origin()`; `bot/deliver` sends
  it with `sendAnimation` and the html as caption, falling back to `sendMessage` when the caption is over 1024
  chars or Telegram refuses the animation, so no message is ever lost.
- `db/schema.subscriptions.every_min integer NOT NULL DEFAULT 15` + CHECK `in (15, 30)` (migration
  `0009_subscription_every_min`, bot-attendee): how often a person's updates come, chosen in Telegram. Strictly
  additive (a constant default: no table rewrite, no drop); verified on top of the 0008 schema with rows in place
  and on a fresh chain. `subscriptions/updates.setUpdateEvery` (audited `subscription.update`) sets it;
  `runUpdates` paces each subscription by it.

Open (after wave 2b): see "Remaining gaps" above, plus `$onUpdate` on `updatedAt()` (svc-people) and
`cancelDirective` accepting vehicle-level directives (admin-phones), both unconfirmed, and:
- In-process state, fine for one container: device API rate limit (api-device), webhook update dedupe
  (bot-core; a `telegram_updates` table would make it durable), pairing throttle is global (svc-pairing).
