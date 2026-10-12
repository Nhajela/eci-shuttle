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

| Table | Key fields | Notes |
|---|---|---|
| `devices` | id, label, token_hash, push_token, model, app_version, update_id, last_sync_at, battery, reported_mode, reported_config_version, killed_at, revoked_at | A phone. Created by QR pairing. |
| `vehicles` | id, name, plate, colour, capacity, active | What attendees see. |
| `routes` | id, name, polyline, stops (Riva, Circle + geofence radius) | |
| `device_assignments` | device_id, vehicle_id, starts_at, ends_at | Time-bound. Reassign = close row + open row. |
| `vehicle_assignments` | vehicle_id, route_id, starts_at, ends_at | Time-bound. |
| `directives` | target (device or vehicle), kind (`active_window`, `silence_until`), starts_at, ends_at, interval_s | Recurring service hours are expanded into dated windows. |
| `pings` | device_id, vehicle_id (resolved at ingest), recorded_at, lat, lng, accuracy, speed, heading, battery | Partition-free; tiny volume. |
| `vehicle_state` | vehicle_id, phase (`at_riva`, `to_circle`, `at_circle`, `to_riva`, `offline`), since, eta_s, last_ping_at | Derived on ingest. |
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

1. **"Where are you?"**: a toggle, `Riva | Circle`. The choice is remembered on the device.
2. **The answer**: one big line, "Shuttle will be here in **6 min**". Underneath it, a small line
   of context ("leaving Circle now · last seen 12s ago"). When there's no live data (>2 min stale, or
   outside service hours), it shows the timetable answer instead, says so plainly
   ("next scheduled: 9:40 · live tracking off"), and never pretends to be live.
3. **The schedule**: today's departures from the chosen stop, with past ones dimmed and the next one highlighted.

No login, no map on first view (could add later behind "Show on map"). Polls every 10s, response cached `s-maxage=5`.

Later, optional: `/shuttle` in a Telegram bot that answers with the same line, and a pinned group message.
- ETA: project the position onto the route polyline, remaining distance ÷ median speed from past trips.
  Dwell time at each end is learned the same way.

## 7. Admin

- Phones: pair new, label, see health (last sync, battery, mode reported vs desired, app version), kill, revoke, nudge.
- Vehicles and routes: CRUD, assign phone ↔ vehicle ↔ route.
- Schedule: recurring service hours per vehicle, one-off "silence until", "force active now for 2h".
- Watchdog (QStash, every minute): a vehicle expected active but silent for >5 min → Telegram DM to ops.

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
- Circle's location, the route, and current service hours. The make of each driver's phone.
