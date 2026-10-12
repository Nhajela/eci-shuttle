# Location service: spike notes (SPEC §8)

What plain Expo does, and what to check on the real driver phones.

## How it runs

- `syncLocationService()` maps `resolveMode()` to the service:
  - active: `Accuracy.High` every `intervalS` (default 10 s), fixes become pings.
  - idle: `Accuracy.Lowest` (network/passive, no GPS) every `idleHeartbeatS`, but never later than the next window
    start (minimum 1 min). Fixes are dropped; the wake is only a clock to re-resolve and heartbeat-sync.
  - killed / revoked / unpaired: updates stopped, so the foreground notification goes away.
- Notification title is the state in IST: "Sharing location until 11:00", "Paused until 16:00" ("Tue 07:00" when it's another day).
- `killServiceOnDestroy: false`, so swiping the app away keeps the service.

## Swiped away / process killed

- Swipe away: the foreground service keeps running; Android restarts JS headless on the next fix and runs the task.
  `service.ts` must be imported at the top of the app entry so `defineTask` and `onLocationWake` are set in headless JS.
- Module state (`appliedKey`) is lost with the process, so the first `syncLocationService()` after a restart always
  re-applies the plan. That is harmless: start on a running task just replaces the options.
- OEM killers (Xiaomi, Oppo, Vivo, Samsung "sleeping apps") can still kill the process. That's what the battery-optimisation
  exemption and autostart deep links in the permission checklist are for. Spike test 1 checks this.

## Reboot

- expo-location has no boot receiver. After a reboot the service does **not** come back until something starts the
  app's JS: opening the app, or a data-only push (spike test 2) whose handler calls `syncLocationService()`.
  expo-task-manager remembers the registered task, but nothing restarts the updates on boot.
- So spike test 3 ("comes back after a reboot without anyone touching the phone") is expected to FAIL with plain Expo.
  The planned fallback (SPEC §8) is a small Kotlin Expo module with a `BOOT_COMPLETED` receiver that starts the app's
  headless JS, which then calls `syncLocationService()`. `RECEIVE_BOOT_COMPLETED` is already in app.config.ts.

## What to check on the phones

1. Active 2 h, screen off, battery saver on: the gap between pings stays near `activeIntervalS`.
2. Idle: the wake really fires around every 15 min with `Accuracy.Lowest`. If it doesn't (no other app asking for
   location), move idle to `Accuracy.Balanced` with a large `distanceInterval` or to the Kotlin clock.
3. The notification text changes at the window edge without opening the app.
