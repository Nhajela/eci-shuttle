# ECI Shuttle — spec

Live visibility of the Edge City India shuttles (Riva ↔ Circle) for attendees, driven by an
Android app on the drivers' own phones that is installed once and then fully server-controlled.

Status: draft for approval · 2026-10-12

## 1. Goals / non-goals

Goals
- Attendees can see where each shuttle is and when it will arrive or leave, in Telegram and on the web.
- Drivers install the APK once (staff do it with them) and never need to touch it again.
- Everything about tracking — when, how often, which phone is which vehicle, kill — is set from the server.
- Phones, vehicles, routes are separate objects; any assignment can be changed at any time.

Non-goals
- iOS, Play Store distribution, multi-language driver UI.
- Turn-by-turn, dispatch, booking seats.

## 2. Repo layout (new private repo `Nhajela/eci-shuttle`, pnpm monorepo)

```
apps/web        Next.js 16 on Vercel: device API, admin, attendee page, Telegram bot webhook
apps/driver     Expo (dev client, Android only) + small Kotlin module if the spike needs it
packages/shared zod protocol schemas, resolveMode() and ETA maths: pure TS, shared by both apps
```

Stack follows the other ECI apps: Neon Postgres (Singapore, `dev` + `main` branches), drizzle,
one service layer `fn(db, actor, input)` with typed errors, one `audit_log`, TDD with Vitest on
local Docker Postgres (template DB, clone per worker). Admin login via Telegram, as in Travel CoOp.

## 3. Domain model

### Workspaces

Every row below belongs to exactly one `workspace`. Workspaces never share data, and the
service layer takes `workspaceId` on every call.

- `live`: the real shuttles. It serves the public page at `/`.
- `test` (and as many more as we want): test phones, test vehicles and a test schedule. Its page is at `/w/<slug>`,
  so the full flow can be run end to end without touching what attendees see.
- A pairing code is created inside a workspace, so a phone joins that workspace when it pairs.
  Moving a phone to another workspace is an admin action. It clears the phone's assignments, and
  the phone picks up the new config on its next sync.
- A **simulated device** is a script (`pnpm sim <workspace> <vehicle>`) that replays the Riva↔Circle
  route through the real sync endpoint. It's the first test phone, used before any real handset is ready.
  Simulated devices are only allowed in non-live workspaces.
- Admin has a workspace switcher, and the test workspaces carry a visible "TEST" banner.

| Table | Key fields | Notes |
|---|---|---|
| `workspaces` | id, slug, name, is_live | |
| `devices` | id, label, token_hash, push_token, model, app_version, update_id, last_sync_at, battery, reported_mode, reported_config_version, killed_at, revoked_at | A phone. Created by QR pairing. |
| `vehicles` | id, name, plate, colour, capacity, active | What attendees see. |
| `spots` | id, name, short_name, lat, lng, radius_m, notes, photo, archived | Any pick-up or drop point: Riva, Circle, a party venue, the beach. Picked on a map in admin. |
| `routes` | id, name, spot_ids[] (ordered), path (polyline), typical_leg_s[] | Riva → Circle → Riva, or Riva → Party → Riva. The path is generated once from a routing API when saved, then editable. Leg times learned from trips. |
| `services` | id, name, kind (`regular`, `special`), route_id, public, colour, valid_from, valid_to, days_of_week, start_time, end_time, pattern (`every N min` or explicit departure times) | The schedule. Regular = the daily Riva↔Circle loop. Special = "Party shuttle, Sat 22:00–02:00". |
| `service_exceptions` | service_id, date, kind (`cancel_day`, `cancel_departure`, `add_departure`, `shift_minutes`), note | Edits to one day without touching the pattern. |
| `service_vehicles` | service_id, vehicle_id, starts_at, ends_at | Which vehicle runs which service, and when. A vehicle used for a party is moved here, and drops out of the Riva↔Circle ETA for those hours. |
| `notices` | text, severity (info / heads-up / urgent), pinned, sort, starts_at, ends_at, placements[], channels[] | One notice, shown in many places. See §6b. |
| `people` | telegram_id, username, first_name, blocked_bot_at | Anyone who has logged in or messaged the bot. |
| `memberships` | person_id, workspace_id, role (admin / ops / viewer) | Admin access. |
| `subscriptions` | person_id, kind (`arrival_alert` one-shot / `notices` for a spot or all), spot_id?, service_id?, lead_min, expires_at | Attendee alerts from the bot. |
| `alert_prefs` | person_id, workspace_id, kinds[], quiet_hours | Which ops alerts each admin gets. |
| `telegram_messages` | chat_id, kind, text, ok, message_id, error | Every message sent, as in Travel CoOp. |
| `login_codes` | code, telegram_id, claimed_at, expires_at | Telegram login, copied from Travel CoOp. |
| `device_assignments` | device_id, vehicle_id, starts_at, ends_at | Time-bound. Reassign = close row + open row. |
| `directives` | target (device or vehicle), kind (`active_window`, `silence_until`, `force_active`), starts_at, ends_at, interval_s | **Overrides only.** The default tracking windows come from `service_vehicles` (each service window ±15 min), so editing the schedule automatically changes when phones track. |
| `pings` | device_id, vehicle_id (resolved at ingest), recorded_at, lat, lng, accuracy, speed, heading, battery | Partition-free; tiny volume. |
| `vehicle_state` | vehicle_id, service_id, phase (`at_spot`, `en_route`, `offline`, `off_duty`), spot_id / next_spot_id, since, eta_s, last_ping_at | Derived on ingest from geofences + route. |
| `trips` | vehicle_id, service_id, from_spot, to_spot, departed_at, arrived_at | Derived. Gives the departure log and the learned leg/dwell times. |
| `audit_log` | actor, action, entity, before/after, at | Every mutation, including device-side kill/resume. |

## 4. Device ↔ server protocol (desired state + reconcile)

There is one endpoint, `POST /api/device/sync`, with a bearer device token:

```
→ { pings: Ping[], battery, charging, reportedMode, appliedConfigVersion, appVersion, updateId, resume?: true }
← { configVersion, killed, revoked, schedule: Window[48h], idleHeartbeatS, activeIntervalS, serverTime }
```

- The phone keeps the last config on disk and runs `resolveMode(config, now)` (from `packages/shared`)
  on its own. Schedule windows still switch on time when the phone has no network.
- Push (FCM through Expo push, data-only) means only "sync now". It is sent whenever a device's
  config changes. If a push is lost, the next heartbeat brings the same change.
- Pings are queued on disk and uploaded in batches. The server dedupes on (device_id, recorded_at).
- `POST /api/device/pair { code }` swaps a short-lived QR/6-digit code (made in admin) for a device token.

### Modes on the phone

| Mode | GPS | Sync | Entered by |
|---|---|---|---|
| active | high accuracy every `activeIntervalS` (default 10s) | every ~15s | inside a schedule window |
| idle | off (only a low-power wake used as a clock) | every `idleHeartbeatS` (default 15 min) | outside windows, or `silence_until` |
| killed | service stopped, notification removed | none | server kill. Latched on disk. Only the Resume button in the app clears it, and the server records who resumed and when |
| revoked | token wiped | none | server revoke (lost phone / driver left). Needs re-pairing |

The foreground-service notification always shows the current state, e.g.
"Sharing location until 11:00" or "Paused until 16:00". The phones belong to the drivers, so they
are only tracked inside windows, and pings are deleted after the event.

## 5. Driver app (Android)

- First run: scan the pairing QR → permission checklist (location "Allow all the time", notifications,
  battery-optimisation exemption, OEM autostart deep links) → green "All set" screen. After that the app is passive.
- Screen: current mode, next window, assigned vehicle, last successful sync, Resume (when killed).
- A foreground service with `foregroundServiceType=location` runs in active and idle, and restarts after reboot.
- EAS Update pinned to `runtimeVersion`: JS updates go over the air, native changes need a new APK.

## 6. Attendee surfaces

The main surface is one simple public web page with three parts, top to bottom:

1. **"Where are you?"**: a toggle of the spots that have a public service running today.
   Usually just `Riva | Circle`. On party night `Party venue` appears too. The choice is remembered on the device.
   Any notices show above it.
2. **The answer**: one big line, "Shuttle will be here in **6 min**". When several services serve
   the chosen spot, there's one line per service ("To Circle: 6 min · Party shuttle: 22:00"). Underneath it, a small line
   of context ("leaving Circle now · last seen 12s ago"). When there's no live data (>2 min stale, or
   outside service hours), it shows the timetable answer instead, says so plainly
   ("next scheduled: 9:40 · live tracking off"), and never pretends to be live.
3. **The schedule**: today's departures from the chosen stop, with past ones dimmed and the next one highlighted.

No login, no map on first view (could add later behind "Show on map"). Polls every 10s, response cached `s-maxage=5`.

Later, optional: `/shuttle` in a Telegram bot that answers with the same line, and a pinned group message.
- ETA: project the position onto the route polyline, remaining distance ÷ median speed from past trips.
  Dwell time at each end is learned the same way.

## 7. Admin (comprehensive, usability first, **phone-first**)

Telegram login (§6c), with roles per workspace. A workspace switcher sits at the top.

**Phone-responsive is a requirement, not a nice-to-have.** Admins will mostly use it on their phones, standing at Riva.
- It's designed at 390px first. Desktop gets more columns, never more features.
- On a phone: a bottom tab bar (Live · Schedule · Notices · Phones · More). Every table becomes a list of cards.
  Every map has a list view beside it. Tap targets are at least 44px. Forms are one column, with sticky Save.
- Time and date inputs use native pickers. Spot pins can be placed by tapping the map or with "Use my current location".
- The common actions take at most 2 taps from the Live board: silence, nudge, post a notice, cancel the next departure.
- Playwright end-to-end tests run every admin page at 390×844 and fail on horizontal scroll or clipped controls.

| Section | What you can do |
|---|---|
| **Live board** | A map of every vehicle in the workspace: phase, ETA, last seen, battery, the service it's running. Problems are flagged (silent, low battery, phone reports a different mode than it was told). |
| **Spots** | Add with a map pin (search or tap), set the geofence radius, rename, archive. |
| **Routes** | Pick spots in order, auto-generate the path and then adjust it, see learned leg times. |
| **Schedule** | A week view of every service. Create a regular or special service (route, days, hours, "every 20 min" or exact times, public on/off). Edit one day: cancel, add or shift a departure, cancel the whole day. Assign vehicles to services for time ranges. "Duplicate as special" for one-offs like a party run. |
| **Vehicles** | CRUD, the current phone, the current service, trip history. |
| **Phones** | Pair (QR + code), label, assign to a vehicle, health, kill / revoke / nudge, silence until, force active for N hours, move to another workspace. |
| **Notices** | Write once, place on any of everywhere / a spot / a service / the schedule / admin. Pin, severity, start and end times. Optionally send to subscribers and post or pin in the group. A preview shows exactly how it looks on each page. |
| **People** | Admins and roles per workspace, alert settings, MCP tokens. Attendee subscriber counts. |
| **Activity** | The audit log, filterable by entity. Each object page also shows its own timeline from it. |
| **Workspaces** | Create test workspaces, start or stop a simulated device. |

Watchdog (QStash, every minute): a vehicle expected active but silent for >5 min, or a phone below 15% battery → Telegram DM to ops.

## 6b. Notices, pinned where they matter

A notice is written once and placed in one or more spots on the site, with start and end times:

| Placement | Where it shows |
|---|---|
| `everywhere` | Top of the public page, whatever spot is picked |
| `spot:<id>` | Only when that spot is picked ("I'm at Riva" → "Pickup is at the side gate today") |
| `service:<id>` | On that service's lines and schedule ("Party shuttle: last run back 02:00") |
| `schedule` | Above the schedule list |
| `admin` | Admin home only (notes between ops) |

- **Pinned** notices stay at the top of their placement in `sort` order until `ends_at`. Unpinned ones show newest first.
  Severity sets the colour and the order. Urgent always comes first.
- **Channels**, on top of the page: send to Telegram subscribers of those spots, and/or post to the main
  group (optionally pinned there, and unpinned automatically when the notice ends).
- Expired notices disappear by themselves, and stay in the audit log and the notices history.
- They can be created from admin, MCP (`notice.create`) or the bot (`/notice` for admins, which walks through placement and duration with buttons).

## 6c. Telegram bot (new bot, e.g. @eci_shuttle_bot)

One bot handles login, admin alerts and attendee communication. It reuses Travel CoOp's patterns:
a webhook with a secret header, a message log, a dev outbox in tests, paced broadcasts, and remembering who blocked the bot.

**Login, same as Travel CoOp.** "Log in with Telegram" → `t.me/<bot>?start=<code>` → the browser polls until
the bot confirms. Messaging the bot directly gets you a magic link, which opens a "Continue as …" page so a link
preview can't log anyone in. A signed session cookie lasts 60 days. Only admin needs login. The public page stays open.

**For admins (you and the ops team):**
- Alerts, depending on each admin's settings: a vehicle silent or off route, low battery, a permission lost, a phone told
  to do one thing and doing another, kill or resume events, changes made by other admins (optional), and a nightly digest of
  insights and timetable suggestions.
- Each alert has buttons for the obvious next step: *Nudge phone* · *Silence 1h* · *Open in admin*.
  Destructive buttons (kill, cancel a day) ask "Are you sure?" with a second button first. Button presses go through the
  service layer with `channel: telegram` and are audited like everything else.
- Quick commands: `/status`, `/today`, `/notice`, `/silence <vehicle> <until>`. Anything bigger is done in admin or by MCP.
- Each workspace has its own alert list, so test alerts never reach the real ops team.

**For attendees:**
- `/shuttle` (or just "riva" / "circle") → the same answer as the page ("Here in 6 min · live"), with spot buttons.
- **"Tell me when it's close"**: a one-shot alert: "Message me when the shuttle is 5 min from Riva".
  The ETA engine fires it once, then it expires (after at most 2h).
- **Notices**: subscribe for one spot or all of them. Urgent notices for a spot go to its subscribers.
- In the group, the bot posts and pins notices when that channel is chosen on the notice.

## 6a. Learning and adaptive schedule

Everything is derived from pings, through the same pipeline:

```
pings → dwells (arrived/left a spot) → trips (spot → spot) → departure matches (actual ↔ planned)
      → rolling stats → ETA model · expected times today · insights · timetable suggestions
```

**Derived tables**
| Table | Holds |
|---|---|
| `dwells` | vehicle, spot, arrived_at, departed_at, matched planned departure |
| `trips` | vehicle, service, from → to, departed_at, arrived_at, path quality (clean / off route / gap) |
| `departure_matches` | planned departure ↔ actual departure, delay in minutes, or `missed` |
| `leg_stats` | leg (from → to), hour bucket, n, median, p20, p80, updated_at |
| `segment_speeds` | route, ~200m segment, hour bucket, median speed. Finds the slow parts (a junction, the market) |
| `suggestions` | kind, evidence, proposed change, status (open / accepted / dismissed), proposal id |

**How it learns**
- Rolling window of the last 7 service days, newer days weighted more. Each stat falls back down a ladder when
  data is thin: leg + hour bucket → leg all day → path distance ÷ 25 km/h (day-1 baseline). The fallback level
  is stored, so the UI can say "estimate" until there are at least 5 samples.
- Trips that went off route, had GPS gaps, or ran more than 3× the median are dropped from the stats. Admin can
  mark a day as "don't learn from this" (e.g. a road closure). Special services learn on their own
  legs, so a party night doesn't distort the Riva↔Circle numbers.
- Matching actual departures to planned ones: in time order, each actual departure takes the nearest
  unmatched planned departure within ±25 min. A planned departure left with no match is `missed`.
- Updated incrementally when a trip closes (cheap). A nightly QStash job recomputes everything and writes suggestions.

**What it powers**
1. **The ETA, with a range.** "Here in 6 min (5–9)". It's built from segment speeds along the remaining path plus
   learned dwell times, and the range is p20–p80. When data is thin it says "about".
2. **Chained predictions.** When the shuttle reaches a spot only after a later trip, the ETA chains legs and
   dwells ("Here in 34 min"). **Attendees never see lateness.** Once there's live data the timetable doesn't
   matter to them: a shuttle 30 min behind its timetable on a 15-min route still shows just "Here in 10 min".
   No "late" or "behind schedule" labels, and no planned-versus-expected times in public. Punctuality is for admin Insights only.
3. **Better guesses with no live data**: the "Next at" time uses the learned typical departure for that slot,
   still labelled "timetable".
4. **Continuous-loop services** (no fixed times): the schedule shows "about every 25 min" from the measured cycle
   time, and the answer is fully predictive.
5. **Insights** (admin page + MCP `shuttle_insights`), per spot and per departure:
   on-time % (within 3 min), average and p80 delay by departure slot (heatmap: time × day), dwell
   by spot and hour, leg time by hour, full loop cycle time, % of service windows actually tracked,
   and the **average wait for someone who turns up at a random time**, worked out from the real headways
   as E[H²] / 2·E[H]. Uneven gaps make waits longer even when the average gap stays the same.
6. **Timetable suggestions, which never apply themselves.** The nightly job writes suggestions with their evidence, e.g.
   - "The 09:40 from Riva left on average 8 min late (p80 12, n=6). Shift it to 09:50?"
   - "A loop takes 52 min, but the timetable needs one every 40 with one vehicle. Change to every 55, or add a vehicle."
   - "Dwell at Circle is 9 min on average, against 3 min planned."
   Accepting one turns it into a normal proposal (same propose/confirm, same audit). Suggestions show in admin,
   in the `shuttle_initialize` snapshot and in `shuttle_suggestions`. The public timetable only changes
   when a person confirms, which also stops a feedback loop of the schedule chasing the drivers.

## 7a. Service layer, audit log, MCP

**One service layer** (`apps/web/src/services`). Every capability is a function `fn(db, actor, input)`
with zod input and typed errors. Roles and workspace scope are enforced here and nowhere else. Admin UI,
the device API, the public page, the watchdog and MCP are thin adapters over it, so a change made from
an AI agent and a change made in admin run exactly the same code.

`actor = { kind: admin | device | system, id, workspaceId, role, channel: web | mcp | device | watchdog, client? }`

**Roles** (per workspace): `admin` can do everything. `ops` can do schedule, notices, silence, force active,
nudge and spots. `viewer` is read-only. Kill, revoke, moving workspaces and role changes are admin only.

**One audit log.** Every mutation writes one `audit_log` row in the same transaction:
actor, channel, client (e.g. "claude.ai"), workspace, action, entity, before → after diff, proposal id
when it came from MCP, and an optional reason. The admin Activity page, each object's timeline and the MCP
`shuttle_activity` tool all read from it. Derived data (pings, vehicle state, trips) isn't audited.
Device-side events that change state (resume, a permission lost) are.

**MCP** at `/api/mcp` (streamable HTTP, stateless), following eci-events-mcp:
- Auth: OAuth, so it works as a claude.ai / ChatGPT connector. "Connect" → Telegram login → a token bound
  to that admin. A personal `shs_` token from the admin settings page covers CLI agents. Revocable, listed in admin.
- `shuttle_initialize` comes first: who you are, your workspaces and roles, today's snapshot
  (vehicles live / offline, today's services, open problems).
- Reads go direct: `shuttle_status` (live board), `shuttle_schedule` (day or week, with exceptions),
  `shuttle_spots`, `shuttle_routes`, `shuttle_vehicles`, `shuttle_phones` (health), `shuttle_activity`,
  `shuttle_public_answer` (exactly what attendees at a spot see right now, for checking a change landed),
  `shuttle_guide`.
- Writes take two steps: `shuttle_propose { workspace, changes: [...] , reason? }` returns a plain-English
  summary, warnings (e.g. "cancelling this leaves Riva without a shuttle 10:00–10:40", "this phone is
  in a live vehicle right now") and a sealed proposal code (10 min, bound to that admin, carries the
  version of every object it touches). `shuttle_confirm { code }` runs all the changes in **one
  transaction**, and refuses if anything changed since the proposal.
- Change kinds: spot create/update/archive · route create/update · service create/update/exception
  (cancel / add / shift a departure, cancel a day) · service vehicle assign/unassign · vehicle create/update ·
  phone label/assign/silence/force-active/nudge/kill/revoke/move-workspace · pairing code create (returns
  QR link + code) · notice create/end · workspace create.
- Example: "The 10:20 from Riva is cancelled today, the shuttle's getting fuel. Tell people." → one proposal
  with the departure cancel and a notice until 10:45 → one confirm → both land, two audit rows, one proposal id.
- Every text sent to a model is an exported constant, as in events-mcp.

## 8. Risks and the day-1 spike

Test plain Expo (`expo-location` + `expo-task-manager` + `expo-notifications`) on the real driver phones:
1. Active tracking survives 2h with the screen off and battery saver on.
2. A data-only push gets a sync through after the app is swiped away.
3. The service comes back after a reboot without anyone touching the phone.

Any failure → that piece moves into a small Kotlin Expo module (service + boot receiver), with JS still in charge.

## 9. Build order

1. Contract: shared zod protocol, `resolveMode()`, DB schema (frozen).
2. In parallel: service layer + sync/pair API · driver app spike → app · admin UI · attendee page + bot.
3. Integration on the dev Neon branch → install on one driver phone → roll out.

## 10. Needs from Naman

- An Expo account (`eas login`) for cloud APK builds, or permission to install JDK 17 for local builds.
- A Firebase project for FCM (needed for push).
- None needed up front for spots or schedule: they're entered in admin. The make of each driver's phone helps the spike.
