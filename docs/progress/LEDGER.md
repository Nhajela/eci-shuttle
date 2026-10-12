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
| svc-insights | merged | read model only; list/dismiss/excludeDay added at integration; **acceptSuggestion still a stub** |
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
| bot-core | merged | built only the webhook adapter; see svc-bot below |
| bot-admin | merged | |
| bot-attendee | merged | built `subscriptions/*` too |
| alerts | merged | |
| activity | merged | +fix (secrets hidden from every reader; IST diff times) |
| mcp-core | merged | +fix. Owns `auth/seal`, `auth/oauth`, `mcp/tokens` |
| mcp-read | merged | +fix (IST datetimes) |
| mcp-propose | merged | depends on `mcp/changes` (stub) |
| api-device | merged | rate limit is in-process (one container) |
| public-ui | merged | +fix (stale minutes hidden; 390px toggle). `/` is force-dynamic |
| admin-shell | merged | |
| admin-live | merged | +fix |
| admin-phones | merged | |
| admin-vehicles | merged | +fix. `app/admin/vehicles/trips.ts` reads the DB directly (stopgap) |
| admin-people | merged | +fix |
| admin-workspaces | merged | +fix (doc). Sim pairing recognised by label until PairRequest gets `simulated` |
| admin-spots | merged | |
| admin-routes | merged | +fix |
| admin-schedule | merged | +fix |
| admin-notices | merged | +fix. Keeps a client copy of `compareNotices` (server module pulls in the DB) |
| admin-insights | merged | +fix. Accept button fails until `acceptSuggestion` lands |
| admin-activity | merged | |
| job-watchdog | merged | |
| job-windows | merged | uses `listAllWorkspaces` |
| job-arrival | merged | |
| job-notices | merged | |
| job-queue | merged | delivers via `bot/deliver.deliverTelegram` (stub) |
| job-nightly | merged | uses `listAllWorkspaces`; cleanup SQL still in the job |
| sim | merged | |

## Not built yet (blocking a working system)

| Key | Owns | What breaks without it |
|---|---|---|
| svc-bot | `S/bot/{handle,start,deliver}.ts`, `callbacks.handleCallback` | the webhook answers nothing (it logs the stub error and returns 200) (no `/start` login claim, so no Telegram login); the queue job can't deliver any Telegram message (alerts, notices, arrival alerts, digest) |
| svc-mcp | `S/mcp/changes.ts` (`versionKeys`, `loadVersions`, `describeChange`, `changeWarnings`, `applyChange`) | `shuttle_propose` / confirm, and so insights' accept |
| svc-insights (rest) | `learning/insights.acceptSuggestion` | needs svc-mcp; add `now: Date`, refuse informational suggestions (`proposedChanges = []`), decide what happens when its proposal expires |
| driver-runtime | a composition root in `apps/driver` | nothing wires location wake → resolveMode → ping queue → `syncOnce` → OTA/push; screens' `syncNow` is a no-op |

## Contract change requests

Applied at integration: barrel exports (geo-wait, sched-windows, sched-mode); `listAllWorkspaces` (job-windows,
job-nightly); `.vitest/` ignored (api-device); `arrive` leadMin documented (bot-attendee); ownership table,
`/login/denied`, `shuttle_login`, hex `token_hash`, `sho_` prefix, `PublicToken`, subscription audit actions,
schedule overlap rule, `loadEstimates` hour param documented in CONTRACTS.md; local haversines / IST helpers /
test stand-ins swapped for the merged real functions.

Open:
- Schema: `devices.permission_lost_since`, `devices.low_battery_since` (alerts); `vehicle_state.off_route_since`
  (alerts, svc-ingest); `routes.typical_leg_s` typed `(number | null)[]` (NULL elements read back as NaN:
  svc-learning, admin-routes); `$onUpdate` on `updatedAt()` (svc-people); exclusion constraint on
  `service_vehicles` (svc-schedule); per-route/spot planned dwell (svc-learning).
- Pairing: `PairRequest.simulated` and a server-side refusal of sim pairing in the live workspace
  (admin-workspaces, sim); `pnpm sim <slug> <vehicle> <code>` (admin-workspaces).
- Alerts: `update_pending` kind vs `mode_mismatch` (alerts); shared `silent` threshold on `PhoneHealth`
  (admin-phones).
- Services: `schedule.listServices(db, actor, {workspaceId})` (admin-schedule, admin-notices);
  `vehicles.listVehicleTrips` (admin-vehicles); per-vehicle phone health read (admin-live, admin-vehicles);
  leg sample counts on `listRoutes` (admin-routes); `getPhone`/`getService` by id for bot callbacks (bot-admin);
  `isSpotName` for bot routing (bot-attendee); `proposalWorkspace(db, personId, code)` and an MCP `actorFor`
  context (mcp-propose, mcp-read); `liveBoard` with its own role check (mcp-read); cleanup service
  (job-nightly); `trackedDevices` (job-windows); `retryAfterMs` on `DeliveryResult` (job-queue);
  shared `escapeHtml` (bot-attendee).
- Adapters: `requireAdmin({ next })` / an `x-pathname` header so logged-out redirects return to the exact page
  (auth-login, admin-shell); shared admin map and `ConfirmButton` in `components/admin/shell` (admin-live,
  admin-phones); confirm `cancelDirective` accepts vehicle-level directives (admin-phones).
- In-process state, fine for one container: device API rate limit (api-device), webhook update dedupe
  (bot-core; a `telegram_updates` table would make it durable), pairing throttle is global (svc-pairing).
