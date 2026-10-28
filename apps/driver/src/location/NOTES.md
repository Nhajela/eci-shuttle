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

## Two builds, one pure decision

`plan.capabilityFor(nativeVersion, degraded)` picks the behaviour from the installed APK's version
(`lib/nativeVersion.ts`: `Updates.runtimeVersion`, which equals the app version because `app.config.ts` uses
`runtimeVersion: { policy: "appVersion" }`; unknown counts as unpatched).

- **patched, >= 0.1.1**: the APK carries a pnpm patch of expo-location (branch `fix/driver-native`) that lets an
  ALREADY RUNNING task be re-registered with new options from the background, and restores the service after reboot.
  A cold start from the background still fails.
- **unpatched, 0.1.0**: nothing can be started or changed from the background. Only `stopLocationUpdatesAsync` works.

### Decision table (`plan.nativeDecision`, run by `apply.ts`)

Stable plan key = accuracy + interval + fixed notification text. No countdown, no clock, nothing that changes as a
window gets closer. On patched builds the active interval is the fastest any active window of the plan needs: `min(activeIntervalS,
window.intervalS)` (idle: the heartbeat), so a force_active 5 s directive is honoured; the key changes with that minimum
(in-place update). Unpatched (0.1.0) always uses `activeIntervalS`: a key change can't be applied from the background
and would only raise "open the app"; the gate still follows the window's cadence.

| Build | Plan (resolved mode) | Task state | Foreground | Background |
|---|---|---|---|---|
| both | killed / revoked / unpaired | running | stop | stop |
| both | killed / revoked / unpaired | not running | nothing | nothing |
| both | any | running, same key, verified in this process | nothing | nothing |
| both | active or idle | running, same key, NOT verified in this process (restored registry) | start (re-register) | nothing (cannot tell, cannot start) |
| patched | active: High, `activeIntervalS` | running, other/unknown key | update in place | update in place (if refused: see below) |
| patched | idle: Lowest, `idleHeartbeatS`, any distance to the next window | running, other/unknown key | update in place | update in place (if refused: see below) |
| patched | active or idle | not running | start | nothing, `needsApp` |
| unpatched | active, or idle with a window within 3 h (16 h if charging): High, `activeIntervalS` (one key, so mode changes never touch it) | running, other/unknown key, or not running | start / update | nothing, `needsApp` (+ reminder) |
| unpatched | idle, next window more than 3 h away (16 h if charging) or none | running | stop | stop (+ reminder) |
| unpatched | idle, next window more than 3 h away (16 h if charging) or none | not running | nothing (+ reminder) | nothing (+ reminder) |

Patched phones never stop for idle: idle uses `Accuracy.Lowest` at the heartbeat, which is cheap, and a background
restart would be impossible. If a background in-place update is still refused (`ForegroundServiceStartNotAllowed`),
the phone records `degradedAt = <native version>` and behaves as unpatched from then on (the status screen says to
open the app before each run). The record is ignored once the APK version changes. A refusal while foregrounded is
not a patch failure: it is recorded as `needsApp` and retried.

### "Running" does not mean "working": `verified`

`hasStartedLocationUpdatesAsync` only reads expo-task-manager's registry, and the registry is rebuilt on every process
start (reboot, OEM/low-memory kill, app open). On 0.1.0 that restore never starts the foreground service, and if
location was off at restore no updates are requested at all. So a persisted key that matches proves nothing. `service.ts`
keeps a module-level `verified` flag, false at every process start and reset by every `AppState` "active"
(`forceReregister()`); the first foreground pass with `plan.run` registers the task again (in place, cheap) and only a
successful foreground start sets it, but only after the runtime has saved the new key (`location.confirm`): a
late, cut-off cycle whose save was refused must not mark the task verified. In the background an unverified-but-matching task is left alone: we can't tell and
can't start it, and a headless wake that gets fixes shows the task is delivering.

`degradedAt` (patch fallback) is set only when a background in-place update of a task we registered in this process
(`verified`) is refused. A refusal on a restored task just sets `needsApp`. A successful foreground start clears it.
Consequence: a headless-only process never marks the patch as broken; it asks for the app instead.

### Why unpatched stops overnight

A 10 s High-accuracy task left on through the ~11 h gap between ops hours (21:00) and the next window (08:00/09:00)
drained a phone from full to dead mid-shift. So with no window within 3 h (`IDLE_STOP_AFTER_MS`) the task is stopped
(allowed from the background), and `reminderAction` keeps one local notification pending, 15 min before the next
window: "Shuttle tracking: open the app to start" (`expo-notifications`, fixed identifier so it is replaced, never
stacked; skipped without notification permission; cancelled as soon as the task runs). The reminder is also scheduled on **any** build whenever `needsApp` is set (e.g. a patched phone whose task was
restored after an OEM kill with the wrong options and whose background update was refused), with the same timing rules.
Reminder times come from the server clock and are converted to the phone clock with the known skew. **On a charger
the overnight stop is skipped** (window up to 16 h ahead): a missed reminder would otherwise mean no tracking all
day, and GPS on a charger is harmless. Unplugged, the next cycle stops the task and schedules the reminder.
Opening the app starts the
task (an `AppState` listener syncs, with up to 3 retries 1.5 s apart while the native side catches up).

### The gate (JS, both builds)

`plan.gateFixes`, called by the runtime for each delivery, judges each fix by its own server time: inside an active
window keep fixes at the window's cadence (its `intervalS`, else `activeIntervalS`; 20% slack for jitter); idle,
killed, revoked, unpaired: drop (SPEC §4: positions only inside windows). Idle check-ins still sync, with no pings.
The time of the last kept fix is persisted (`lastKeptAt`), because every delivery may run in a fresh process.

### Code map

Pure and tested: `capabilityFor`, `locationPlan`, `planKey`, `nativeDecision`, `gateFixes`, `reminderTarget`,
`reminderAction`, `isForegroundNotAllowed` in `plan.ts`. `apply.ts` does the native and reminder calls through
injected interfaces. `service.ts` is only expo wiring. A cycle that timed out (`runtime.ts`) makes no native call and saves nothing, and every save merges into what is on
disk. The runtime persists `nativeKey`, `needsApp`, `degradedAt`,
`reminderFor` and `lastKeptAt` in `sync-state`, because module state is lost with the process. Keep
`mayShowUserSettingsDialog: false`.

Consequences: on 0.1.0 the driver opens the app before each run (the reminder prompts it) and GPS runs in the 3 h
before a window and through it, plus the gaps inside the day. On 0.1.1 the phone polls at `Lowest` accuracy all day
and switches itself, except after a reboot/force-stop, which needs the app opened once. Recommend a charger.

## Swiped away / process killed

- Swipe away: the foreground service keeps running (`killServiceOnDestroy: false`); Android restarts JS headless on
  the next fix and runs the task. `service.ts` must be imported at the top of the app entry so `defineTask` and
  `onLocationWake` are set in headless JS.
- Module state is lost with the process, so everything the decision needs (`nativeKey`, `needsApp`, `lastKeptAt`)
  lives in `sync-state` on disk.
- OEM killers (Xiaomi, Oppo, Vivo, Samsung "sleeping apps") can still kill the process. That's what the
  battery-optimisation exemption and autostart deep links in the permission checklist are for.

## Reboot

- expo-task-manager already ships a boot receiver: `TaskBroadcastReceiver` listens for `BOOT_COMPLETED` and
  `MY_PACKAGE_REPLACED` (expo-task-manager `AndroidManifest.xml`). Constructing `TaskService` restores the persisted
  tasks (`TaskService.java:87-91`, `restoreTasks` `:550`), so `LocationTaskConsumer.didRegister` runs inside the
  receiver and restarts the location updates.
- Unpatched (0.1.0): expo-location then skips the foreground service because the app is not foregrounded
  (`LocationTaskConsumer.kt:181`), leaving throttled background updates and no notification. Opening the app restores
  everything. The reminder notification is lost with the pending alarms on some phones.
- Patched (0.1.1): Android allows a `location` foreground service to start from `BOOT_COMPLETED` /
  `MY_PACKAGE_REPLACED` (Android 15 forbids only dataSync, camera, mediaPlayback, phoneCall, mediaProjection and
  microphone there; `location` needs `ACCESS_BACKGROUND_LOCATION`, which the driver grants). So no extra Kotlin
  receiver is needed: `patches/expo-location@57.0.21.patch` makes the consumer attempt the service start instead of
  bailing (and catches a refusal), and lets a background re-registration of a running task update it in place.
- The restored notification text is whatever was last registered; it no longer contains a clock, so it stays accurate.
- Reboot with nobody touching the phone must be verified on a phone with the 0.1.1 APK.

## What to check on the phones

0. After a reboot or a low-memory kill (task registry restored, no service): open the app. Fixes must flow again;
   the status screen must never show "all good" with a silent notification bar.
1. 0.1.0: open the app once: the notification appears and fixes flow every ~10 s in a window.
2. 0.1.0 overnight: after the last window ends, the task stops (no foreground notification), battery stays flat, and
   the reminder shows 15 min before the first window. Tapping it and opening the app starts tracking.
3. 0.1.1: through an idle gap and into a window, with the app in the background, pings start at ~10 s with no
   interaction; the first ping is at most one idle heartbeat late. Check that `Accuracy.Lowest` really delivers
   a fix every `idleHeartbeatS` (if it doesn't, the phone never notices the window start).
4. 0.1.1: a background switch that throws leaves `degradedAt` set and the note on the status screen.
5. Kill or revoke from admin while backgrounded: the notification goes away at the next sync (both builds).
6. Force-stop (task gone): the status screen says "Open the app to start tracking"; opening it starts tracking.
