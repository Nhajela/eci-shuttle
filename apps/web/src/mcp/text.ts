/**
 * web-mcp: every text the MCP server sends to a model (SPEC §7a: "every text sent to a model is an exported
 * constant"). Tool groups add their own tool texts as exported constants in their own files.
 */
import type { ServiceErrorCode } from "@/services/kernel";

export const SERVER_NAME = "eci-shuttle";
export const SERVER_TITLE = "ECI Shuttle";
export const SERVER_VERSION = "1.0.0";

export const SERVER_INSTRUCTIONS = [
  "You help the Edge City India 2026 ops team (Mandrem, Goa, 11 Oct – 1 Nov 2026) run the Riva ↔ Circle shuttles: live vehicles, the schedule, phones in the vehicles, notices to attendees, as far as this person's role allows.",
  "",
  "RULES:",
  "1. Never fabricate. If a tool didn't return it, say you don't know.",
  "2. Every time is India time (IST, Asia/Kolkata). Tools already convert; quote them as given.",
  "3. Every change goes through shuttle_propose, then shuttle_confirm only after the person explicitly says yes to the summary.",
  "4. Never ask for a token or a login code in chat. People connect only on this server's own sign-in page.",
  "",
  "Call shuttle_initialize first. It tells you who this is, their workspaces and roles, and today's snapshot.",
].join("\n");

export const RULES = `## Rules
1. Never fabricate. If a tool didn't return it, say you don't know.
2. Times are India time (IST). Tools already convert; quote them as given.
3. Changes take two steps: \`shuttle_propose\` returns a plain-English summary, warnings and a code; read them to the person, and call \`shuttle_confirm\` only after an explicit yes. Never confirm on your own.
4. Every change is audited under this person's name, with this connection as the client.
5. Attendees never see lateness. When writing notices or explaining the public page, never say "late" or compare planned and expected times.
6. Workspaces never share data. Pass \`workspace\` (the slug) when the person has more than one; test workspaces are for trying things without touching what attendees see.`;

export const ROLES_TEXT = `Roles: admin can do everything; ops can change the schedule, notices, spots, vehicles, and silence, force active or nudge phones; viewer can only read. Kill, revoke, moving a phone between workspaces, pairing codes, app updates and new workspaces are admin only.`;

export const NO_WORKSPACES = `You aren't a member of any workspace yet, so there is nothing to show or change. Ask an ECI Shuttle admin to add you in admin → People.`;

export const SNAPSHOT_PART_FAILED = (what: string) => `${what}: couldn't load right now.`;

export const INITIALIZE_TOOL = {
  name: "shuttle_initialize",
  title: "Start here",
  description:
    "Call first in every conversation. Returns the time now in IST, who you are acting as, your workspaces and roles, today's snapshot per workspace (vehicles, today's services, open problems, open timetable suggestions), the rules, and which tools to use.",
} as const;

export const GUIDE_TOOL = {
  name: "shuttle_guide",
  title: "Guide",
  description:
    "Detailed guidance for one area before you act on it: how changes, the schedule, phones, notices, roles or learning work, including every change kind with its fields.",
  topicArg: "Which area.",
} as const;

export const WORKSPACE_ARG =
  "Workspace slug from shuttle_initialize. Optional when you have only one workspace; otherwise the live workspace is used.";

export const TOOLS_HEADER = "## Tools";
export const GUIDE_SECTION = `- \`shuttle_guide\`: depth on one area (changes, schedule, phones, notices, roles, learning). Read \`changes\` before your first proposal.`;

const OPS_HOURS_GUIDE = `Ops tracking hours (admin): \`workspace.update { opsHoursStart: "09:00", opsHoursEnd: "21:00" }\` (IST, every day; both null turns them off) makes every phone assigned to a vehicle track all through those hours, not only in service windows. Outside services the vehicle is off duty ("between shifts"): \`shuttle_status\` and the Live board show its last position and "off duty", attendees never see it, no trips or departures are learned from it, and it raises no silent or off-route alert. A silence still pauses a phone; kill and revoke still win.`;

export const GUIDES = {
  changes: `# Changes (propose, then confirm)
1. Read the current state first (status, schedule, phones…), so ids and versions are current.
2. \`shuttle_propose { workspace, changes: [...], reason? }\` checks every change against your role and the current data, stores nothing yet, and returns a plain-English line per change, warnings, and a code valid for 10 minutes, bound to you.
3. Read the summary and every warning to the person. Only after an explicit yes, call \`shuttle_confirm { code }\`.
4. Confirm runs all changes in one transaction. If anything changed since the proposal, nothing is applied (STALE_VERSION): read again and propose again. An expired or used code is GONE: propose again.
5. Put related changes in one proposal (e.g. cancel a departure and post a notice about it), so they land together under one proposal id.
Updates carry an optional \`version\` (from the read tools): pass it, so a change made meanwhile by someone else isn't overwritten.
App updates go out the same way: \`ota.rollout\`, \`ota.rollback\` (whole workspace) and \`ota.phone\` (one phone); see the phones topic.
${OPS_HOURS_GUIDE}`,
  schedule: `# Schedule
- A service is a route run on some days between start and end time (IST), with a pattern: every N minutes, explicit departure times, or a continuous loop (no fixed times; shown as "about every N min").
- Regular services are the daily Riva ↔ Circle loop; special ones are one-offs (a party shuttle). Only public services show to attendees.
- Edit one day without touching the pattern with \`service.exception\` and its \`type\`: cancel_day; cancel_departure or add_departure (\`departure\` HH:MM); shift_minutes (\`departure\` and \`minutes\`, ±180). \`date\` is the IST service day (a 01:00 departure of a 22:00–02:00 service belongs to the day before).
- Times of day are HH:MM IST. Date-times are ISO with an offset, e.g. 2026-10-12T10:45:00+05:30.
- Vehicles run services for time ranges (\`service_vehicle.assign\` / \`unassign\`). A vehicle moved to a party run drops out of the Riva ↔ Circle ETA for those hours.
- Driver breaks: when you hear a driver is on a break, \`vehicle.break { vehicleId, minutes? , note? }\` (no minutes = until \`vehicle.break_end { vehicleId }\`). The vehicle stays on its service and its phone keeps tracking, but attendees get no ETA from it, a loop counts one shuttle fewer, and it raises no silent or off-route alert. When every shuttle is on a break, attendees see "on a short break" and when it's back if known. \`shuttle_status\` shows \`onBreakUntil\`. Breaking again replaces the end time.
- Phones track inside each assigned service window ±15 minutes, so schedule edits change when phones track.
- The planned wait at stops (boarding time) is on the route: \`route.update { routeId, plannedDwellS: { "*": 300 } }\` = wait 5 min at each stop; add a spot id key to override one stop (seconds, 0 = no wait; the map replaces the whole plan, \`{}\` clears it). It feeds "about every N min" and ETAs until enough real dwells are learned.`,
  phones: `# Phones (the drivers' own Android phones)
- A phone is paired to a workspace with a pairing code (admin), labelled, and assigned to a vehicle. It tracks only inside its tracking windows and is idle otherwise.
- One vehicle can have several sources at once as backups of each other (our app, Telegram live location via /pair, Traccar): \`phone.assign\` each to the same vehicle; assigning never takes another source off. The newest fix from any of them moves the vehicle; it is silent only when all are. \`shuttle_phones\` shows each source's \`lastFixAt\`. Take one off with \`phone.assign { deviceId, vehicleId: null }\`.
- ${OPS_HOURS_GUIDE}
- silence (until a time): stop tracking until then. force_active (for some hours): track now even outside a window. nudge: ask the phone to sync now. These are ops.
- kill: stop the phone's tracking until the driver presses Resume in the app. revoke: wipe its token (lost phone, driver left); it needs pairing again. move_workspace: moves it and clears its assignments. These are admin only, and a phone in a live vehicle right now gets a warning.
- Health: last sync, battery, permissions, the mode it reports versus the mode it was told.
- App updates (over the air, admin only): \`ota.rollout { updateId }\` tells every phone in the workspace to run that update (null stops targeting; phones keep what they run). \`ota.rollback\` targets the update from before the last rollout again. \`ota.phone { deviceId, updateId }\` overrides one phone (null = follow the workspace again) and pushes it. \`shuttle_phones\` shows the workspace target, each phone's running update and override, "update failed" and "needs new APK".
- A phone downloads the update in the background and applies it only while idle, never during a tracking window. An update built for a newer native runtime is ignored by phones on an older APK; they show "needs new APK" until the driver installs it. Try an update on the test workspace's phones first.`,
  notices: `# Notices
- One notice, written once, placed in one or more places: everywhere (top of the public page), spot:<id> (when that spot is picked), service:<id> (that service's lines), schedule (above the timetable), admin (notes between ops).
- Severity info, heads_up or urgent; urgent always comes first. Pinned notices stay on top in sort order until they end.
- starts_at / ends_at bound when it shows; it disappears by itself after. \`notice.end\` ends one now.
- Channels on top of the page: subscribers (Telegram subscribers of those spots), group (post in the main group), group_pin (post and pin; unpinned when it ends).
- Write for attendees: plain, short, IST times, never "late" or "behind schedule".`,
  roles: `# Workspaces and roles
- \`live\` is what attendees see at the public page. Test workspaces have their own phones, vehicles and schedule, at /w/<slug>; use them to try things.
- ${ROLES_TEXT}
- Your role is per workspace; shuttle_initialize lists yours.
- ${OPS_HOURS_GUIDE}`,
  learning: `# Learning, insights and suggestions
- Everything is learned from the phones' pings: dwells at spots, trips between them, matches of actual to planned departures, then rolling 7-day stats.
- ETAs come with a range (p20–p80) and say "about" when data is thin.
- Insights (admin only, never shown to attendees): on-time %, delay by departure slot, dwell, leg times, loop cycle time, % of windows tracked, average wait for someone turning up at random.
- Timetable suggestions never apply themselves: accepting one turns it into a normal proposal that a person confirms.`,
} as const;
export type GuideTopic = keyof typeof GUIDES;

export const CHANGE_KINDS_HEADER = "## Change kinds (role needed; * = required field)";

/** Errors a tool returns; the code comes first so a model can branch on it. */
export const ERROR_HINTS: Partial<Record<ServiceErrorCode, string>> = {
  FORBIDDEN: "Your role in this workspace doesn't allow this. Say so; an admin can do it or change your role.",
  NOT_FOUND: "Not found in this workspace. Read the list again for current ids.",
  STALE_VERSION: "Something changed since you read it. Read again, then propose again.",
  GONE: "That code expired or was already used. Propose again.",
  UNAUTHENTICATED: "This connection is no longer valid. Ask the person to reconnect.",
};
export const INTERNAL_ERROR = "INTERNAL_ERROR: Something went wrong on our side. It has been logged; please try again.";
export const UNKNOWN_WORKSPACE = (slug: string, known: string[]) =>
  `NOT_FOUND: You have no workspace "${slug}". Yours: ${known.join(", ") || "none"}.`;
export const PICK_WORKSPACE = (known: string[]) =>
  `INVALID: You have several workspaces and none is live. Pass workspace, one of: ${known.join(", ")}.`;

/** Sent with the 401 that starts OAuth in a connector. */
export const UNAUTHORIZED_DESCRIPTION = "Connect this server from your MCP client to sign in with Telegram.";
