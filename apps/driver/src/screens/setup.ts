import type { Permissions } from "@eci-shuttle/shared/contracts";

/** First-run order (SPEC §5): consent → scan the QR → permission checklist → status. */
export function nextRoute(s: { consentAt: number | null; paired: boolean; setupDoneAt: number | null }) {
  if (s.consentAt === null) return "/consent" as const;
  if (!s.paired) return "/pair" as const;
  if (s.setupDoneAt === null) return "/permissions" as const;
  return "/status" as const;
}

export type ChecklistItem = {
  key: "location" | "notifications" | "battery" | "autostart";
  title: string;
  hint: string;
  /** null = can't be checked from the app */
  done: boolean | null;
  required: boolean;
};

export function checklist(p: Permissions): { items: ChecklistItem[]; allSet: boolean } {
  const items: ChecklistItem[] = [
    {
      key: "location",
      title: "Location: Allow all the time",
      hint: "Choose “Allow all the time” and keep “Use precise location” on.",
      done: p.location === "always" && p.preciseLocation,
      required: true,
    },
    {
      key: "notifications",
      title: "Notifications",
      hint: "Shows when your location is being shared.",
      done: p.notifications,
      required: true,
    },
    {
      key: "battery",
      title: "Battery: Unrestricted",
      hint: "Stops Android from putting the app to sleep.",
      done: p.batteryOptimizationExempt,
      required: true,
    },
    {
      key: "autostart",
      title: "Autostart",
      hint: "On some phones: allow the app to start by itself after a restart.",
      done: null,
      required: false,
    },
  ];
  return { items, allSet: items.every((i) => !i.required || i.done) };
}

type Intent = { packageName: string; className: string };
const i = (packageName: string, className: string): Intent => ({ packageName, className });
const XIAOMI = [i("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")];
const OPPO = [
  i("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
  i("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
  i("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
];
const HUAWEI = [
  i("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
  i("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
];
// ponytail: well-known OEM component names; they shift between OS versions, so the screen tries each and falls back to app settings.
const AUTOSTART: Record<string, Intent[]> = {
  xiaomi: XIAOMI,
  redmi: XIAOMI,
  poco: XIAOMI,
  oppo: OPPO,
  realme: OPPO,
  oneplus: [i("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"), ...OPPO],
  vivo: [
    i("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
    i("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
  ],
  huawei: HUAWEI,
  honor: HUAWEI,
  asus: [i("com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity")],
  letv: [i("com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity")],
};

/** OEM "autostart" screens to try, in order, for Device.manufacturer. Empty = the phone has none. */
export function autostartIntents(manufacturer: string | null): Intent[] {
  return AUTOSTART[manufacturer?.toLowerCase() ?? ""] ?? [];
}
