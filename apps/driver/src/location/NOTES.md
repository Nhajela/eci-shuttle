# Location service: how it works and why (SPEC §8)

What plain Expo does, and what to check on the real driver phones.

## The constraint that shapes everything

expo-location 57 (`LocationModule.kt`, `startLocationUpdatesAsync`) throws `ForegroundServiceStartNotAllowedException`
whenever the app is **not foregrounded** (`AppForegroundedSingleton.isForegrounded` is false) and the options carry a
`foregroundService`. It does so even when the task and its service are already running, so *any* call to
`startLocationUpdatesAsync` from a background wake fails. Android 12+ forbids starting a foreground service from the
background anyway.

The first design retuned the task on every mode change (idle: `Accuracy.Lowest` every 15 min, active: `High` every 10 s,
notification text with the time of the next change). Every retune happened in a background wake, so it threw, and
`runtime.ts` swallowed it. A phone stayed in whatever mode it had when the app was last on screen: idle phones never
started GPS for a shift, active phones kept GPS on all night.

## The model now: one task per tracking day, mode decided in JS

- **Start (and stop) only while the app is on screen.** `service.ts` passes `AppState.currentState === "active"` as
  the foreground signal. In the background we never call `startLocationUpdatesAsync` or `stopLocationUpdatesAsync`.
- The task is started once with **fixed options**: `Accuracy.High`, `timeInterval` = the ACTIVE interval
  (`activeIntervalS`, default 10 s), and a notification with the same text all day ("ECI Shuttle", "Location is on for
  today's shuttle runs"). No countdowns or clocks: a foreground notification can't be refreshed from the background,
  so any time in it would go stale. `planKey()` covers exactly these options, so it does not change as a window
  gets closer or when the mode flips, and nothing restarts.
- **The gate is JS** (`plan.gateFixes`, called by the runtime for each delivery, each fix judged by its own server time):
  - active window: keep fixes at the window's cadence (its `intervalS`, else `activeIntervalS`; 20% slack for jitter);
  - idle: keep one fix per `idleHeartbeatS` and drop the rest, so the server still gets check-ins;
  - killed / revoked / unpaired: drop everything.
  The time of the last kept fix is persisted (`lastKeptAt`), because every delivery may run in a fresh headless process.
- **When the plan says no tracking for a long time** (revoked / killed / unpaired, or idle with no window in the next
  `TRACKING_HORIZON_MS` = 16 h) the task is stopped, but only if the app is on screen. In the background it keeps
  running and the gate drops its fixes.
- **Background and the native state is wrong** (no task, or one started by an older build, or with other options): we do
  not try. `applyLocationPlan` returns `needsApp: true`, the runtime persists it in `sync-state`, and the status screen
  says "Open the app to start tracking". Opening the app runs a sync (`AppState` listener in `runtime/native.ts`),
  which starts the task and clears the flag. A start that the OS still refuses because JS saw "active" a moment before
  the native side did is caught and recorded the same way, and retried up to 3 times 1.5 s apart.
- Decision logic is pure and tested: `locationPlan`, `nativeDecision`, `gateFixes`, `isForegroundNotAllowed` in
  `plan.ts`; `apply.ts` does the native calls through an injected interface; `service.ts` is only expo wiring.
- Keep `mayShowUserSettingsDialog: false`.

Consequences: a driver (or admin) must open the app on each phone once before the day's first run (and once after the
OTA that ships this model, to replace the old task). The GPS stays on through the gaps between runs and only stops
when the app is next opened after the horizon has passed. Recommend the phone stays on a charger.

## Swiped away / process killed

- Swipe away: the foreground service keeps running (`killServiceOnDestroy: false`); Android restarts JS headless on
  the next fix and runs the task. `service.ts` must be imported at the top of the app entry so `defineTask` and
  `onLocationWake` are set in headless JS.
- Module state is lost with the process, so everything the decision needs (`nativeKey`, `needsApp`, `lastKeptAt`)
  lives in `sync-state` on disk.
- OEM killers (Xiaomi, Oppo, Vivo, Samsung "sleeping apps") can still kill the process. That's what the
  battery-optimisation exemption and autostart deep links in the permission checklist are for.

## Reboot

- expo-location has no boot receiver. After a reboot the task does **not** come back until the app is opened (a
  data-only push only runs the sync, which now cannot start the task from the background). Opening the app starts it.
- The planned fallback (SPEC §8) is a small Kotlin Expo module with a `BOOT_COMPLETED` receiver; Android 12+ also
  restricts starting a location foreground service from boot, so check that before building it.

## What to check on the phones

1. Fresh install / after the OTA: open the app once: the notification appears and fixes flow every ~10 s in a window.
2. Leave the app in the background through an idle gap and into a window: pings resume at ~10 s with no
   interaction; before and after, only one ping per heartbeat. Status screen never shows "Open the app" while it runs.
3. Force-stop the app (task gone), wait: the status screen shows "Open the app to start tracking" next time it is
   opened; opening it starts tracking within a few seconds.
4. Kill from admin while backgrounded: pings stop (gate); the notification stays until the app is next opened.
5. Active 2 h, screen off, battery saver on: the gap between pings stays near `activeIntervalS`.
