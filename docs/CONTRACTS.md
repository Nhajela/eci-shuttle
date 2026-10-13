# Contracts and ownership

Frozen for the parallel build. The spec (`docs/SPEC.md`) says *what*; this file says *where* and *through which
interface*. Each stub's JSDoc is the detailed contract for that function: implement exactly that signature.

## 1. Frozen files (nobody edits them in a task)

| File | What |
|---|---|
| `packages/shared/src/contracts/*` | zod protocol + input schemas, enums, `McpChange`, public status, schedule types |
| `packages/shared/src/time/*` | IST helpers: `istDate`, `istHHMM`, `istWeekday`, `istToEpoch`, `formatIst` |
| `packages/shared/src/index.ts`, `src/geo/index.ts`, `src/schedule/index.ts` | barrels |
| `apps/web/src/db/schema.ts`, `db/types.ts`, `db/index.ts` | every table, row types, `Db`, `db()`, `rawSql()` |
| `apps/web/src/services/kernel/*` | `Actor`, `ServiceError`, `mutate`, `enqueue`, roles, scope |
| `apps/web/src/lib/env.ts`, `lib/utils.ts`, `components/ui/*` | env access, `cn`, shadcn/ui |
| `apps/worker/src/{job,runner,lock,main}.ts`, `jobs/index.ts`, `jobs/heartbeat.ts` | worker frame |
| `tests/global-setup.ts`, `tests/setup-db.ts`, `tests/helpers/*`, `tests/factories/core.ts`, `vitest.config.mts` | test infra |
| `CLAUDE.md`, `docs/CONTRACTS.md`, `docs/progress/LEDGER.md`, root configs, `Dockerfile` | foundation |

**Contract change requests**: make the smallest local workaround (a private helper in your own file, a local
type) and report the needed change in your task result (`contractRequests`). The orchestrator batches them.

## 2. Interfaces

### Service functions (`apps/web/src/services/<module>/<file>.ts`)
- Shape: `fn(db: Db, actor: Actor, input, now?: Date)`; public/system reads may drop `actor`. `db` may be a
  transaction: services compose inside one (MCP confirm runs many in one transaction).
- Validate with `parseInput(Schema, input)` (zod failure → `INVALID`). Inputs are the `*Input` schemas exported
  next to each function (most are `withWorkspace(<Fields from shared>)`).
- Authorize first: `requireRole(actor, workspaceId, "viewer" | "ops" | "admin")` (writes) / `readable()` (reads),
  `requireDevice` for device calls. Load rows with `getInWorkspace` (another workspace's row = `NOT_FOUND`).
- Write with `mutate(db, actor, { action: "<entity>.<verb>", entity, workspaceId }, async (tx) => ({ before, after, result }))`.
  Bump `version` on every update; check it with `checkVersion(row, input.version, entity)`.
- Side effects: `enqueue(tx, { kind: "telegram" | "push", payload, workspaceId, dedupeKey })` inside the mutation.
- Errors: throw `ServiceError(code, plainEnglishMessage, details?)`. Adapters map once: `httpStatus(e)`, `userMessage(e)`.
- Call other modules by importing the function from its file (e.g. `@/services/devices/config`), never through
  a barrel, and never by duplicating their SQL.

### Audit
One `audit_log` row per mutation (`mutate`). `action` is a dotted verb (`spot.create`, `phone.kill`,
`subscription.create`, `subscription.cancel`, `subscription.cancel_all` (entityId null, before/after = count),
`session.login`, `mcp_token.revoke`, `suggestion.dismiss`, `learning.exclude` …). Not audited: derived data (pings, vehicle_state,
dwells, trips, matches, stats), and worker bookkeeping (`notices.sent_at`, `subscriptions.fired_at/cancelled_at`
on expiry, outbox status, `mcp_tokens.last_used_at`, heartbeat, login/pairing/proposal code lifecycle).

### Settled at integration (wave 2)
- Device tokens: `devices.token_hash` = lowercase hex sha256 of the raw token (`devices/sync.authenticateDevice`).
- MCP tokens: personal `shs_…`, OAuth-issued `sho_…`; `listTokens`/`revokeToken` return `PublicToken`
  (`McpToken` without `tokenHash`). Admin pages use `PublicToken`.
- `catalog/schedule.assignServiceVehicle`: the same vehicle twice on the same service with overlapping times is
  `CONFLICT`; overlaps across services are allowed (a party run).
- `catalog/workspaces.listAllWorkspaces(db)`: system read for worker jobs (no actor).
- `learning.loadEstimates(db, input, now, hour?)`: optional IST hour bucket (default: the current hour).
- `bot/callbacks`: `arrive:<spotId>[:<leadMin>]`.
- Shared barrels also export `headwaysFromDepartures`, `applyDirectives`, `VehicleDirective`, `notificationText`.

### Settled at integration (wave 2b)
- Schema: `devices.permission_lost_since` / `low_battery_since` (episode starts, written by the watchdog: unaudited
  derived bookkeeping), `vehicle_state.off_route_since` (ingest), `routes.planned_dwell_s` (jsonb
  `{ spotId: seconds }`, default `{}`), `routes.typical_leg_s` typed `(number | null)[]` (null = not learned).
- `PairRequest.simulated?`: stored on `devices.simulated`; a simulated pair into the live workspace is `FORBIDDEN`.
- `service_vehicles` overlap stays a service-level rule (row lock in catalog/schedule); no DB exclusion constraint
  (drizzle-kit can't emit one).
- `McpChange` `service.create` / `service.update` carry the service's kind as `serviceKind` (`kind` is the change
  discriminator); create defaults to `regular`.
- `DeliveryResult` retry variant has optional `retryAfterMs` (Telegram 429); the queue uses it instead of backoff.
- New reads: `schedule.listServices` / `getService`, `vehicles.listVehicleTrips`, `spots.isSpotName` (system read),
  `phones.getPhone` / `getVehiclePhone` / `trackedDevices` (system read), `mcp/changes.actorFor` / `liveBoard`,
  `mcp/proposals.proposalWorkspace`, `cleanup.runCleanup(db, pingsDeleteAfter, now)`. `lib/telegram/html.escapeHtml`
  is the one HTML escaper for Telegram text.

### Actors (`services/kernel/actor.ts`, built by adapters only)
| Adapter | Builds |
|---|---|
| admin pages / server actions | `lib/session.requireAdmin()` → `auth/actor.adminActor(channel "web")` |
| bot | `auth/actor.adminActor(channel "telegram")` or `auth/actor.attendeeActor(person, ws)` |
| MCP | `mcp/tokens.authenticateMcp` → `auth/actor.adminActor(channel "mcp", client)` |
| device API | `devices/sync.authenticateDevice` (kind device) |
| worker | `systemActor("<job>")` |

### Time
Pure functions take `now` (epoch ms); services take `now: Date` last. Display in IST via shared `time/*`.

### Outbox and Telegram
`kernel/outbox.enqueue` → worker `queue` job → `bot/deliver.deliverTelegram` / `devices/push.deliverPush`
(`DeliveryResult`). Only `services/bot/deliver.ts` calls api.telegram.org; only `services/devices/push.ts` calls
Expo. Webhook replies are performed immediately with `bot/deliver.performReply` (logged in `telegram_messages`).
Inline buttons: `bot/callbacks.encodeCallback` (≤ 64 bytes, actions listed in `CallbackAction`).

### Worker (`apps/worker`)
- Scheduler: **croner** (cron patterns in IST, seconds resolution, `protect` = no overlapping ticks).
- Queue: **the Postgres `outbox` table** (claim with `FOR UPDATE SKIP LOCKED`), no queue library.
- `Job = { name, schedule, lock?, run(ctx) }`; `runJob` holds the advisory lock `job:<name>` (skip when held),
  catches and logs errors. `ctx = { db, now, workerId, startedAt, log }`. Jobs call services, never SQL
  (exception: `jobs/queue.ts` claims outbox rows).
- Build: `pnpm --filter @eci-shuttle/worker build` → `apps/worker/dist/worker.cjs` (bundled).

| Job | Schedule (IST) | Calls |
|---|---|---|
| heartbeat | every min, no lock | `health.recordHeartbeat` |
| watchdog | every min | `alerts/watchdog.runWatchdog` |
| windows | every min | `devices/config.bumpConfigs`, `ingest.refreshPhases` |
| arrival-alerts | every 15 s | `subscriptions.runArrivalAlerts` |
| notices | every min | `notices.runNoticeLifecycle` |
| queue | every 2 s | outbox → `bot/deliver.deliverTelegram`, `devices/push.deliverPush` |
| learning | 02:30 | `learning.recomputeAll`, `alerts.sendDigest` per workspace |
| cleanup | 03:30 | expired codes/proposals, old outbox, pings after `PINGS_DELETE_AFTER` |

### URLs (all under `PUBLIC_ORIGIN`)
| Path | Owner | Notes |
|---|---|---|
| `/` , `/w/<slug>` | web-public | public page (live / test workspace) |
| `GET /api/status?w=<slug>` | web-public | `PublicStatus`, `Cache-Control: s-maxage=5` |
| `/admin/<page>?w=<slug>` | admin-* | pages: live, phones, vehicles, people, workspaces, spots, routes, schedule, notices, insights, activity; `/admin` → `/admin/live` |
| `/login`, `/login/magic?code=` | web-auth | Telegram login, magic link "Continue as …" |
| `/login/denied` | web-auth | logged in, but no membership or the role is too low |
| `/api/auth/*` | web-auth | start, poll, magic (POST), logout: route shapes are the owner's |
| `POST /api/telegram` | web-bot | webhook, `X-Telegram-Bot-Api-Secret-Token` |
| `/api/mcp` | web-mcp | streamable HTTP, stateless |
| `/api/mcp/oauth/{register,authorize,token}` | web-mcp | OAuth 2.1 + PKCE over `services/auth/oauth` |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` | web-mcp | metadata |
| `POST /api/device/sync`, `POST /api/device/pair` | web-device | device protocol (SPEC §4) |
| `GET /api/health` | contracts | 200 iff DB ok and a worker beat < 3 min ago |

Cookies: `shuttle_session` (signed, 60 days, `auth/session`), `shuttle_ws` (admin workspace choice),
`shuttle_login` (the pending Telegram deep-link code, httpOnly, 10 min). Admin
workspace resolution: `?w=` → cookie → live → first membership (`auth/actor.resolveWorkspace`).

### Tests
`*.test.ts` unit, `*.db.test.ts` Postgres (a cloned DB per Vitest worker; tables start empty, every test makes
its own rows; global tables like `worker_heartbeat` may be cleared in `beforeEach` of your own file).
Factories: `tests/factories/core.ts` (`makeWorkspace`, `makePerson`, `makeAdmin`); add yours in
`tests/factories/<task-key>.ts`. External APIs are injected (`fetchImpl`) and faked.

## 3. Ownership (one task key per file; tests and `tests/factories/<key>.ts` belong to the same key)

Paths: `S` = `apps/web/src/services`, `A` = `apps/web/src/app`, `C` = `apps/web/src/components`,
`G` = `packages/shared/src`, `W` = `apps/worker/src`.

### Wave 1 (running now)
| Key | Owns |
|---|---|
| contracts | everything in §1, `S/health/*`, `A/api/health`, `W/*` frame, placeholders, docs |
| geo-path | `G/geo/path.ts` |
| geo-geofence | `G/geo/geofence.ts` |
| geo-eta | `G/geo/eta.ts` |
| geo-leg | `G/geo/legEstimate.ts` |
| geo-wait | `G/geo/averageWait.ts` |
| sched-departures | `G/schedule/departures.ts` |
| sched-windows | `G/schedule/windows.ts` |
| sched-mode | `G/schedule/resolveMode.ts` |
| sched-match | `G/schedule/matchDepartures.ts` |
| svc-workspaces | `S/catalog/workspaces.ts` |
| svc-spots | `S/catalog/spots.ts` |
| svc-routes | `S/catalog/routes.ts` |
| driver-scaffold | `apps/driver/**` |

### Wave 2 (services)
| Key | Owns |
|---|---|
| svc-vehicles | `S/catalog/vehicles.ts` |
| svc-people | `S/catalog/people.ts` |
| svc-schedule | `S/catalog/schedule.ts` |
| svc-config | `S/devices/config.ts`, `S/devices/ota.ts` |
| svc-phones | `S/devices/phones.ts` |
| svc-pairing | `S/devices/pairing.ts` |
| svc-sync | `S/devices/sync.ts`, `S/devices/push.ts` |
| svc-ingest | `S/ingest/*` |
| svc-learning | `S/learning/learning.ts` |
| svc-insights | `S/learning/insights.ts` |
| svc-notices | `S/notices/*` |
| svc-public | `S/public/*` |
| activity | `S/activity/*` |
| auth-login | `S/auth/{actor,codes,session}.ts` |
| mcp-core | `S/auth/{seal,oauth}.ts`, `S/mcp/tokens.ts` |
| mcp-propose | `S/mcp/proposals.ts` |
| svc-mcp (**not built yet**) | `S/mcp/changes.ts` |
| svc-bot (**not built yet**; `callbacks` encode/decode done at integration) | `S/bot/{types,handle,start,callbacks,deliver}.ts` |
| bot-admin | `S/bot/admin.ts` |
| bot-attendee | `S/bot/attendee.ts`, `S/subscriptions/*` |
| alerts | `S/alerts/*` |
| job-windows | `W/jobs/windows.ts` |
| job-queue | `W/jobs/queue.ts` |
| job-learning | `W/jobs/learning.ts` |
| job-cleanup | `W/jobs/cleanup.ts` |

`W/jobs/{watchdog,arrival-alerts,notices}.ts` are already wired to their services: no task edits them.

### Wave 2/3 (adapters and UI)
| Key | Owns |
|---|---|
| web-auth | `A/login/**`, `A/api/auth/**`, `apps/web/src/lib/session.ts` |
| web-bot | `A/api/telegram/**`, `apps/web/src/lib/telegram/**`, `apps/web/scripts/setup-bot.mjs` |
| web-mcp | `A/api/mcp/**`, `A/.well-known/**`, `apps/web/src/mcp/**` (every text sent to a model is an exported constant there) |
| web-device | `A/api/device/**` |
| web-public | `A/(public)/**`, `C/public/**`, `A/api/status/**` |
| admin-shell | `A/admin/layout.tsx`, `A/admin/page.tsx`, `C/admin/shell/**` |
| admin-live | `A/admin/live/**`, `C/admin/live/**` |
| admin-phones | `A/admin/phones/**`, `C/admin/phones/**` |
| admin-vehicles | `A/admin/vehicles/**`, `C/admin/vehicles/**` |
| admin-people | `A/admin/people/**`, `C/admin/people/**` |
| admin-workspaces | `A/admin/workspaces/**`, `C/admin/workspaces/**` |
| admin-spots | `A/admin/spots/**`, `C/admin/spots/**` |
| admin-routes | `A/admin/routes/**`, `C/admin/routes/**` |
| admin-schedule | `A/admin/schedule/**`, `C/admin/schedule/**` |
| admin-notices | `A/admin/notices/**`, `C/admin/notices/**` |
| admin-insights | `A/admin/insights/**`, `C/admin/insights/**` |
| admin-activity | `A/admin/activity/**`, `C/admin/activity/**` |
| sim | `apps/web/scripts/sim.ts` |
| e2e | `apps/web/e2e/**`, Playwright config (390×844, fails on horizontal scroll or clipped controls) |

Admin pages share only `C/ui/*` (frozen) and `C/admin/shell/*` (admin-shell). A component two pages need is
copied or requested from admin-shell, not imported across page folders. Server actions live next to their page
(`A/admin/<page>/actions.ts`) and call services with the Actor from `lib/session.requireAdmin`.
