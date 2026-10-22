# ECI Shuttle: where we are

Last updated: Tue 13 Oct 2026, ~10:40 IST. Companion docs: `SPEC.md` (the design), `RESUME.md` (how to pick up work),
`CONTRACTS.md` (code layout and ownership), `progress/LEDGER.md` (build history).

## What it is

Attendees see where the Edge City India shuttles are and when the next one reaches their stop. Drivers' phones report
GPS. The server decides when phones track, and ops run everything from an admin site, a Telegram bot, or an AI agent
over MCP.

- **Public page:** https://eci-shuttle.positivesumcompany.com ("Where are you?" → "Here in N min" / "here now").
- **Admin:** https://eci-shuttle.positivesumcompany.com/admin (Telegram login, phone-first).
- **Bot:** @eci_shuttles_bot (login, alerts with action buttons, `/shuttle`, driver pairing).
- **MCP:** https://eci-shuttle.positivesumcompany.com/api/mcp (OAuth + DCR; works as a claude.ai connector).
- **Repo:** github.com/Nhajela/eci-shuttle (open source, MIT). Every push to `main` deploys.

## Live setup (eci-main)

| Thing | Value |
|---|---|
| Stops | Nanu Resort (15.680278, 73.710722, 150 m) · Riva Beach Resort (15.671151, 73.710554, 200 m) · Circle co-work (15.650722, 73.716417, 150 m) |
| Route | Riva → Circle → Riva (road path from OSRM), 5 min planned wait at each stop (16 Oct) |
| Public services (loop, daily until 1 Nov) | One loop "Shuttle", 08:00–22:00 (16 Oct) |
| Ops tracking hours | 09:00–21:00 daily. Phones track and admin sees positions between shifts; the public only sees service hours |
| Shuttle 1 | Shift 08:00–16:00 daily. Android phone running our driver app |
| Shuttle 2 | Shift 14:00–22:00 daily. iPhone sharing Telegram live location via `/pair`. Traccar Client is the planned backup if Telegram shows gaps |
| Admins | @HiiNaman (admin in eci-main and test). Viewers can be added in People by Telegram username |
| Test workspace | `test`: Riva + a placeholder Circle, a test phone in "Test shuttle", public page at `/w/test` |

## What was built

**The server and admin** (Next.js + Postgres on Coolify, Mumbai VPS):
- **One service layer** with roles (admin / ops / viewer) per workspace, and **one audit log** for every change.
- **Workspaces:** `eci-main` (live) and `test`, fully separated.
- **Catalog:** stops (map pin and radius), routes with road paths, services (fixed times, every N min, or continuous
  loop), one-day exceptions, vehicles, and staffing.
- **Live state:** ingest turns GPS into stop arrivals, trips and an ETA with a range; off-route and offline detection;
  phases (at a stop, en route, off duty, offline).
- **Learning:** leg and dwell stats, insights, timetable suggestions that a person confirms. A planned wait per stop is
  used until real data takes over.
- **Public page:**
  - Spot picker, one big answer and the day's schedule, with a beta card.
  - It never shows lateness, never "live tracking off", and never "about every N min".
  - A finished service is hidden while a later one is still coming.
- **Admin** (phone-first): Live board with map, Phones, Vehicles, People, Workspaces, Spots, Routes, Schedule, Notices
  (placed per stop or service, pinned), Insights, Activity.
- **Telegram bot:**
  - Login with confirmation, so the deep link can't be hijacked.
  - Alerts with buttons (nudge, silence 1h, open admin): silent phone, off route, low battery, permission lost,
    killed/resumed.
  - `/shuttle` (add a workspace slug, e.g. `/shuttle test`), arrival alerts, notice subscriptions, `/setgroup`.
  - `/pair <code>` plus Telegram **live location** for drivers without our app.
- **MCP:** read tools plus propose → confirm. Changes can cover spots, routes, services, staffing, vehicles, phones
  (assign, silence, force active, kill, revoke, move), pairing codes, notices, **OTA rollouts** and **workspace ops
  hours**.
- **Worker:** watchdog, service windows, arrival alerts, notices, a queue (Telegram and push), nightly learning, cleanup.
  Postgres locks prevent double-sends.
- **Traccar endpoint** `/api/device/traccar` for iPhones (Traccar Client app).
- **Health:** `/api/health` (DB plus worker heartbeat, for uptime monitoring) and `/api/health/live` (Coolify's container
  check, which is now on and passing).

**Driver app** (Expo, Android APK):
- Pairing by QR code or 6-digit code, then a permission checklist (location always, battery optimisation, OEM
  autostart, notifications).
- Server-controlled modes (active, idle, killed, revoked). A kill is latched until the driver presses Resume, and the
  phone confirms the kill back.
- GPS while active (about every 10 s) and a check-in every 3 min while idle. Points are queued offline.
- OTA updates are server-controlled: an update id is rolled out per workspace or phone, and a phone applies it only
  while idle. Failures are reported back.
- APK: https://expo.dev/artifacts/eas/RGwHBbBtzbEej6F4NI47ZnZNTsQiZtV_CF_eAqcheeI.apk (runtime 0.1.0, channel `live`).

**Verified on real phones today:**
- Pairing and permissions.
- Live ETA and "here now".
- Notice placement.
- Telegram alerts.
- Kill → "Stopped by the shuttle team" → Resume, with the kill confirmed back.
- Two OTA updates applied.
- MCP setup of a whole workspace.
- Ops hours showing an off-duty position.

## Known issues

1. **Push ("sync now") doesn't wake phones.**
   - Expo and Firebase report delivery `ok`, but the app doesn't sync on it.
   - Mitigation: idle phones check in every 3 min, and active phones every ~15 s anyway.
   - Needs `adb logcat` from an Android phone over USB to find where it breaks.
2. **Traccar on iOS stops in the background.** Reason #1 is iOS suspending it. Moving that driver to Telegram live
   location is the likely fix.
3. **Telegram live location** is merged and the webhook is registered, but it hasn't been tried with a real phone yet.
4. The nightly "dwell much longer than planned" suggestion still compares against 3 min, so 5-min waits will trigger it.
5. A loop service can't change just *today's* hours (the workaround is to cancel the day and add a one-off special
   service).
6. The 390px Playwright tests exist (`pnpm test:ui`); some known failures are marked.
7. The Dockerfile header still mentions `/api/health?live=1`; Coolify actually uses `/api/health/live`.

## Ideas for later

**Soon (useful this week):**
- Move the iPhone driver to Telegram live location (`/pair`), and retire the Traccar entry.
- A **"today's hours"** edit for loop services, so break-time changes take one step.
- An MCP `member.set`, so admins and viewers can be added from chat, plus a bot DM telling new members how to log in.
- Find and fix the push wake bug (Android logs), then lower the idle check-in back toward 15 min to save data.
- Words instead of `off_duty` in `shuttle_status`, with "between shifts" on the board.
- A daily ops digest on Telegram: trips run, gaps, phones that went silent.

**Native iOS app** (needs an Apple Developer team):
- Someone adds you to their team as **App Manager** with certificate access, or gives an **App Store Connect API key**.
- Then add iOS config to the Expo app and do an EAS iOS build, distributed through TestFlight. That's about an hour of
  work plus Apple processing.

**Later:**
- Real-world learning settles once a few days of trips exist. Review Insights and accept the timetable suggestions.
- Seat or "shuttle full" signal from drivers (one tap in the app).
- "I'm waiting at Riva" taps from attendees, so drivers can see demand.
- A public map, behind a "Show on map" link.
- Moving Postgres into a shared instance with a database per app.
- Re-running the lens reviews (correctness, security, phone UI, spec edges, e2e) that were cut short.

## Accounts and access

- **Coolify:** project `eci-shuttle` with apps web (`a33lowo2rnr1wixpdoeuuzzy`) and worker (`qicmzefd26d3p9nji7o6xqyr`)
  from the same Dockerfile (worker uses `ROLE=worker`), and its own Postgres. Secrets live in Coolify env vars and on
  Naman's machine (`~/.secrets`, repo `.env.local`).
- **Expo:** `positive-sum-company/edge-city-india-shuttles`.
  - Build: `cd apps/driver && npx eas-cli build -p android --profile live`.
  - OTA: `npx eas-cli update --channel live --platform android --environment preview --message "…"`, then roll it out
    via MCP `ota.rollout` / `ota.phone`.
- **Firebase:** project `eci-shuttles`. The FCM V1 key is stored in Expo credentials.
- **DNS:** Cloudflare A record `eci-shuttle` → the VPS.
