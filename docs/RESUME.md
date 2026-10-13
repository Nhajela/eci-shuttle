# Resume here

Paused 2026-10-13 08:35 IST, just before Naman's 08:30 driver onboarding. Read this first, then `docs/SPEC.md`,
`docs/CONTRACTS.md` and `docs/progress/LEDGER.md`.

## What is live

- **Site:** https://eci-shuttle.positivesumcompany.com. Admin is at `/admin`, test public page at `/w/test`, MCP at `/api/mcp`
  (OAuth with DCR). Health is `/api/health`.
- **Hosting:** Coolify on the Mumbai VPS. Every push to `main` auto-deploys **web** and **worker**: the same Dockerfile,
  with `ROLE=worker` for the worker. Postgres is its own Coolify container, internal only.
  - On every start, web runs the drizzle migrations (`apps/web/drizzle`) and a bootstrap (`apps/worker/src/migrate.ts`).
    The bootstrap creates workspaces `eci-main` (live) and `test`, and makes `BOOTSTRAP_ADMINS=HiiNaman` admin of every
    workspace once that person exists.
  - **Schema changes:** run `drizzle-kit generate` (in apps/web) and commit the SQL. The next deploy applies it.
- **Coolify ids** (not secrets): project `t6vgoy2an6iyimivnehflimv`, web `a33lowo2rnr1wixpdoeuuzzy`,
  worker `qicmzefd26d3p9nji7o6xqyr`, db `oustrmfrh72vda8fzqkcpelz`, server `flismobftzu4etgmosyr7c6g`.
- **Telegram bot:** @eci_shuttles_bot. Its webhook is registered at `/api/telegram`. Re-register with
  `node apps/web/scripts/setup-bot.mjs`, which needs TELEGRAM_BOT_TOKEN, PUBLIC_ORIGIN and TELEGRAM_WEBHOOK_SECRET.
- **Driver app (Expo):** project `positive-sum-company/edge-city-india-shuttles` (id 77b687ca-…), Firebase project
  `eci-shuttles`.
  - APK: https://expo.dev/artifacts/eas/RGwHBbBtzbEej6F4NI47ZnZNTsQiZtV_CF_eAqcheeI.apk (runtime 0.1.0).
  - Build: `cd apps/driver && npx eas-cli build -p android --profile live`. Use EAS, because Gradle downloads time out on
    Naman's machine.
  - OTA: `cd apps/driver && npx eas-cli update --channel live --platform android --environment preview --message "..."`.
    Then set the Android update id as the target in admin → Phones → rollout panel.
  - Phones apply an update only while **idle**.
  - JS-only changes are OTA-able. Native changes need `version` bumped in app.config.ts and a new APK.
- **Secrets** are only on Naman's machine (`~/.secrets/`, repo-root `.env.local`) and in Coolify env vars.
  A cloud session has none of them. Coolify API, logs and env changes need Naman's machine or a token he provides.

## Verified on a real phone (Nothing A015, test workspace)

- Pairing.
- Permissions checklist.
- GPS ingest: here now / here in N min.
- Notice placement per spot.
- Telegram alerts: off route, killed, resumed.
- Kill → "Stopped by the shuttle team" → Resume.
- Kill acknowledgement (the phone reports `killed`).
- OTA update applied while idle.
- MCP propose/confirm for spots, routes, services, staffing, phones and notices.
- Bot `/shuttle test` (a member can name a workspace slug last).

## Open work, in priority order

1. **Push "sync now" doesn't wake phones.** The worker logs `[queue] sent` and Expo returns ticket ok, but the phone
   only syncs on its next heartbeat (15 min while idle) or when the app opens.
   - Commit 598fdc7 logs `[push] device <id> ticket <ticketId>` in the worker.
   - Next: nudge a phone (MCP `phone.nudge`). Read the ticket id from the worker log. Fetch the receipt with
     `POST https://exp.host/--/api/v2/push/getReceipts {"ids":[...]}` and look for an FCM error
     (credentials or sender mismatch).
   - Credentials: an FCM V1 key is attached in Expo to the Android credentials for `com.positivesumcompany.ecishuttle.driver`.
   - App side: `apps/driver/src/push/push.ts`. `definePushSyncTask` and `registerTaskAsync` are wired in
     `src/runtime/native.ts`.
   - If FCM is fine, check whether Android delivers data-only high-priority messages to the background task.
2. **MCP OTA change kinds.** Naman asked for this; it isn't started.
   - Add `ota.rollout {updateId|null}`, `ota.rollback`, `ota.phone {deviceId, updateId|null}` (admin).
   - Each wraps the existing `services/devices/ota.ts` functions.
   - Wire them like other kinds: `packages/shared/src/contracts/inputs.ts` and `mcp.ts`, then CHANGE_ROLE, versionKeys,
     describeChange, changeWarnings and applyChange in `apps/web/src/services/mcp/changes.ts`, plus the guide text.
     Write the tests first.
3. **Web health check is off in Coolify.** Alpine's `wget localhost` resolves to ::1, but Next binds 0.0.0.0.
   Set `ENV HOSTNAME=::` in the Dockerfile run stage, or make the check use 127.0.0.1. Then re-enable the health check
   (path `/api/health`). Its response includes worker heartbeat freshness.
4. **Real eci-main setup**, through the MCP:
   - Riva and Circle with their real pins. Circle is in Mandrem; get the exact pin from Naman.
   - The Riva ↔ Circle route.
   - The real timetable.
   - Vehicles, and phones assigned to them as drivers pair.
   - The test workspace's Circle is a placeholder at Naman's location (15.6687, 73.719).
5. **Open review findings** (from lens review round 2, not yet fixed):
   - `services/ingest/ingest.ts` `matchDate()` writes `missed` rows for unstaffed departures (only staffed should count).
   - `apps/driver/src/ota/ota.ts`: an OTA target the phone can't fetch fails silently. It should report updateFailed so
     admin rollback works.
   - SPEC §7 asks for Playwright 390×844 tests on every admin page (no horizontal scroll or clipped controls). They don't exist.
   - `services/devices/phones.ts` `modeMismatch` still flags a killed phone that hasn't acked. That's mostly moot now
     the phone acks the kill, but align it with the watchdog's grace logic.
   - Bot spot buttons in a `/shuttle test` reply answer from the live workspace (callbacks ignore the slug).
6. Lens review round 3 never ran its fixes. Re-run a lens review (correctness, security, phone UI, spec edges, e2e)
   when there's time.

## How to resume

- **On Naman's machine (full access):** open Claude Code in `edgecityindia26/eci-shuttle` and say "resume from
  docs/RESUME.md". Coolify helpers are in `~/.secrets/coolify.py` (deploy and app tokens), and the logs token is in
  `~/.secrets/coolify-logs-token`.
- **From a cloud session (code only):** clone `Nhajela/eci-shuttle` and say "resume from docs/RESUME.md, items 1–2 and 5".
  Pushing to `main` deploys by itself.
  - There's no Coolify or log access, so ask Naman to paste worker log lines for the push receipts, or to provide a token.
  - Tests need Docker Postgres (`pnpm test-db`, then `pnpm test`). Skip the DB tests if Docker isn't available.
- Keep pushes to `main` small and green: every push redeploys the live server, briefly (seconds of 502 while the
  health check is off).
