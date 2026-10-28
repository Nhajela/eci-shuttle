/**
 * svc-bot: admin side (SPEC §6c For admins). Quick commands only; anything bigger is done in admin or by MCP.
 * Each builds the actor with auth/actor.adminActor(channel "telegram"); no membership → "This is for the ops team."
 * An optional trailing workspace slug picks a test workspace ("/status test").
 * Handlers never write themselves: every change is a service call (mutate → audit_log). A ServiceError from a
 * command propagates (handle.ts turns it into a reply); a button press answers it as an alert toast.
 */
import {
  formatIst,
  Id,
  istDate,
  istHHMM,
  istToEpoch,
  type NoticeChannel,
  type NoticePlacement,
  type NoticeSeverity,
} from "@eci-shuttle/shared";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { devices, directives, people, services } from "@/db/schema";
import type { Workspace } from "@/db/types";
import { origin } from "@/lib/env";
import { escapeHtml } from "@/lib/telegram/html";
import { MUTE_ALL, muteAlert, muteEntityFor } from "@/services/alerts/alerts";
import { detectProblems } from "@/services/alerts/watchdog";
import { adminActor, resolveWorkspace } from "@/services/auth/actor";
import { setRole } from "@/services/catalog/people";
import { addException, getSchedule } from "@/services/catalog/schedule";
import { listSpots } from "@/services/catalog/spots";
import { listVehicles } from "@/services/catalog/vehicles";
import { updateWorkspace } from "@/services/catalog/workspaces";
import { isOutsideApp, killPhone, listPhones, nudgePhone, resumePhone, silencePhone } from "@/services/devices/phones";
import { vehicleStates } from "@/services/ingest/ingest";
import { createNotice, listNotices } from "@/services/notices/notices";
import {
  type Actor,
  can,
  isServiceError,
  readable,
  requireRole,
  ServiceError,
  type TelegramButton,
  userMessage,
} from "../kernel";
import { type Callback, encodeCallback } from "./callbacks";
import type { BotContext, BotReply, TgCallbackQuery } from "./types";

const H = 3_600_000;
/** Problem kinds a mute button can name (alerts/watchdog Problem["kind"]). */
const MUTABLE_KINDS = new Set([
  "silent",
  "off_route",
  "low_battery",
  "permission_lost",
  "mode_mismatch",
  "update_failed",
  "update_pending",
]);
const KIND_WORDS: Record<string, string> = {
  silent: "silent",
  off_route: "off-route",
  low_battery: "low battery",
  permission_lost: "permission",
  mode_mismatch: "mode mismatch",
  update_failed: "update",
  update_pending: "update",
};
const esc = escapeHtml;
const TEST_TAG = "TEST workspace: ";
const tag = (ws: Workspace) => (ws.isLive ? "" : `<i>${TEST_TAG}${esc(ws.slug)}</i>\n`);
/** IST time, with the day when it isn't today. */
const when = (t: Date, now: Date) => (istDate(t) === istDate(now) ? istHHMM(t) : formatIst(t));
const btn = (text: string, action: Callback["action"], ...args: string[]): TelegramButton => ({
  text,
  callbackData: encodeCallback({ action, args }),
});

const say = (ctx: BotContext, html: string, buttons?: TelegramButton[][]): BotReply => ({
  send: [{ chatId: ctx.chatId, html, kind: "reply", personId: ctx.person.id, ...(buttons?.length && { buttons }) }],
});
const toast = (q: TgCallbackQuery, text?: string, showAlert?: boolean): BotReply => ({
  send: [],
  answerCallback: { callbackQueryId: q.id, ...(text && { text }), ...(showAlert && { showAlert }) },
});
/** Replace the pressed message (confirm steps, wizard). No message (too old) → just the toast. */
const editTo = (q: TgCallbackQuery, html: string, buttons: TelegramButton[][] = [], text?: string): BotReply =>
  q.message
    ? { ...toast(q, text), edit: { chatId: q.message.chat.id, messageId: q.message.message_id, html, buttons } }
    : toast(q, text);
const expired = (q: TgCallbackQuery) => toast(q, "This button has expired.");
/** `fn` in a transaction holding a lock on `key`: concurrent presses of one button (double tap, Telegram retry) run one after the other, so check-then-write stays idempotent. */
const locked = <T>(ctx: BotContext, key: string, fn: (db: Db) => Promise<T>): Promise<T> =>
  ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    return fn(tx);
  });

/** The person's admin Actor in the workspace `slug` names (null = their live, else first, membership). */
async function asAdmin(ctx: BotContext, slug: string | null): Promise<{ actor: Actor; ws: Workspace }> {
  const r = await resolveWorkspace(ctx.db, ctx.person.id, slug);
  if (!r) throw new ServiceError("FORBIDDEN", "This is for the ops team.");
  if (slug && r.workspace.slug !== slug) throw new ServiceError("NOT_FOUND", "You're not in that workspace.");
  return { actor: await actorIn(ctx, r.workspace.id), ws: r.workspace };
}
const actorIn = (ctx: BotContext, workspaceId: string) =>
  adminActor(ctx.db, { personId: ctx.person.id, workspaceId, channel: "telegram" });

// ---------------------------------------------------------------- /setgroup

/** `/setgroup [slug]`, sent in the Telegram group: makes it the workspace's group (notices' group channels). admin. */
export async function onSetGroup(ctx: BotContext, args: string[], inGroup: boolean): Promise<BotReply> {
  if (!inGroup) return say(ctx, "Send /setgroup in the group you want the shuttle's group notices to go to.");
  const { actor, ws } = await asAdmin(ctx, args[0] ?? null);
  await updateWorkspace(ctx.db, actor, { workspaceId: ws.id, groupChatId: ctx.chatId });
  return say(ctx, `${tag(ws)}This group now gets the shuttle's group notices.`);
}

// ---------------------------------------------------------------- /status

/** `/status [slug]`: each vehicle's phase, ETA, last seen, battery (IST times), then open problems (alerts/watchdog). viewer+. */
export async function onStatus(ctx: BotContext, args: string[]): Promise<BotReply> {
  const { actor, ws } = await asAdmin(ctx, args[0] ?? null);
  readable(actor, ws.id);
  const input = { workspaceId: ws.id };
  // sequential: ctx.db may be a transaction
  const vehicles = await listVehicles(ctx.db, actor, input);
  const states = await vehicleStates(ctx.db, ws.id);
  const phones = await listPhones(ctx.db, actor, input, ctx.now);
  const spots = await listSpots(ctx.db, actor, input);
  const problems = await detectProblems(ctx.db, ws.id, ctx.now);
  const spot = (id: string | null) => spots.find((s) => s.id === id)?.shortName ?? "the next stop";

  const lines = vehicles
    .filter((v) => v.active)
    .map((v) => {
      const s = states.find((x) => x.vehicleId === v.id);
      const d = phones.find((p) => p.vehicle?.id === v.id && !p.device.revokedAt)?.device;
      let text = "no data yet";
      if (s?.phase === "at_spot") text = `at ${spot(s.spotId)}`;
      else if (s?.phase === "en_route")
        text = `to ${spot(s.nextSpotId)}${s.etaS == null ? "" : ` in ${Math.max(1, Math.round(s.etaS / 60))} min`}`;
      else if (s) text = s.phase === "offline" ? "offline" : "off duty";
      if (s?.lastPingAt) text += ` · seen ${when(s.lastPingAt, ctx.now)}`;
      if (d?.battery != null) text += ` · battery ${Math.round(d.battery)}%${d.charging ? " (charging)" : ""}`;
      return `<b>${esc(v.name)}</b>: ${esc(text)}`;
    });
  const probs = problems.map((p) => `• ${esc(p.message)} (since ${when(p.since, ctx.now)})`);
  return say(
    ctx,
    `${tag(ws)}<b>Status at ${istHHMM(ctx.now)}</b>\n${lines.join("\n") || "No vehicles yet."}\n\n` +
      (probs.length ? `<b>Problems</b>\n${probs.join("\n")}` : "No problems."),
  );
}

// ---------------------------------------------------------------- /today

/** `/today [slug]`: today's services and departures, with exceptions marked. viewer+. Ops get cancel-the-day buttons. */
export async function onToday(ctx: BotContext, args: string[]): Promise<BotReply> {
  const { actor, ws } = await asAdmin(ctx, args[0] ?? null);
  const date = istDate(ctx.now);
  const [day] = await getSchedule(ctx.db, actor, { workspaceId: ws.id, from: date, days: 1 });
  const ops = can(actor, ws.id, "ops");
  const blocks: string[] = [];
  const buttons: TelegramButton[][] = [];
  for (const { service, exceptions, departures } of day?.services ?? []) {
    const head = `<b>${esc(service.name)}</b>${service.public ? "" : " (not public)"}`;
    const off = exceptions.find((e) => e.kind === "cancel_day");
    if (off) {
      blocks.push(`${head}: cancelled today${off.note ? ` (${esc(off.note)})` : ""}`);
      continue;
    }
    const times = departures.map(
      (d) =>
        istHHMM(d.at) + (d.added ? " (added)" : d.shiftedMin ? ` (${d.shiftedMin > 0 ? "+" : ""}${d.shiftedMin})` : ""),
    );
    const cancelled = exceptions.filter((e) => e.kind === "cancel_departure").map((e) => e.departure);
    blocks.push(
      `${head}\n${times.join(", ") || "No departures left."}${cancelled.length ? `\nCancelled: ${cancelled.join(", ")}` : ""}`,
    );
    if (ops) buttons.push([btn(`Cancel ${service.name} today`, "cday", service.id, date.replace(/-/g, ""))]);
  }
  return say(
    ctx,
    `${tag(ws)}<b>Today, ${formatIst(ctx.now).split(",")[0]}</b>\n\n${blocks.join("\n\n") || "No services today."}`,
    buttons,
  );
}

// ---------------------------------------------------------------- /silence

/** Pure. "2h" / "45m" from now, or "HH:MM" IST at its next occurrence; null for anything else. */
export function parseUntil(s: string, now: Date): Date | null {
  const rel = /^(\d{1,3})([hm])$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    return n > 0 ? new Date(+now + n * (rel[2].toLowerCase() === "h" ? H : 60_000)) : null;
  }
  const hm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!hm) return null;
  const t = istToEpoch(istDate(now), `${hm[1].padStart(2, "0")}:${hm[2]}`);
  return new Date(t > +now ? t : t + 24 * H);
}

/**
 * `/silence <vehicle> <until> [slug]`: vehicle by name (case-insensitive prefix), until "HH:MM" IST (next
 * occurrence) or "<n>h" / "<n>m"; silences that vehicle's phone (devices/phones.silencePhone). ops+.
 */
export async function onSilence(ctx: BotContext, args: string[]): Promise<BotReply> {
  const i = args.findIndex((a) => parseUntil(a, ctx.now));
  const until = i > 0 ? parseUntil(args[i], ctx.now) : null;
  if (!until)
    return say(ctx, "Use: /silence &lt;vehicle&gt; &lt;until&gt;, e.g. /silence Bus 1 16:00 or /silence Bus 1 2h");
  const { actor, ws } = await asAdmin(ctx, args[i + 1] ?? null);
  const q = args.slice(0, i).join(" ").toLowerCase();
  const matches = (await listVehicles(ctx.db, actor, { workspaceId: ws.id })).filter((v) =>
    v.name.toLowerCase().startsWith(q),
  );
  const v = matches.find((x) => x.name.toLowerCase() === q) ?? (matches.length === 1 ? matches[0] : null);
  if (!v)
    return say(
      ctx,
      matches.length ? `Which one? ${matches.map((x) => esc(x.name)).join(", ")}` : `No vehicle called "${esc(q)}".`,
    );
  // every source on the vehicle (app, Telegram, Traccar), or a backup would keep it tracking
  const phones = (await listPhones(ctx.db, actor, { workspaceId: ws.id }, ctx.now)).filter(
    (p) => p.vehicle?.id === v.id && !p.device.revokedAt,
  );
  if (!phones.length) return say(ctx, `${esc(v.name)} has no phone right now.`);
  for (const p of phones)
    await silencePhone(ctx.db, actor, { workspaceId: ws.id, deviceId: p.device.id, until: until.toISOString() });
  const labels = phones.map((p) => esc(p.device.label)).join(", ");
  return say(
    ctx,
    `${tag(ws)}Silenced ${esc(v.name)} (${labels}) until ${when(until, ctx.now)}. It won't share location until then.`,
  );
}

// ---------------------------------------------------------------- /invite

const ROLE_WORD = { viewer: "viewer (sees the Live board and the map)", ops: "ops", admin: "admin" } as const;

/**
 * `/invite @username [viewer|ops|admin|remove] [slug]` (admin only, default viewer): gives that person access to
 * admin and the staff map, and DMs them how to log in. They must have messaged the bot once (setRole NOT_FOUND).
 */
export async function onInvite(ctx: BotContext, args: string[]): Promise<BotReply> {
  const [user, word = "viewer", slug = null] = args;
  const role = word.toLowerCase();
  if (!user || !(role in ROLE_WORD || role === "remove"))
    return say(ctx, "Use: /invite @username [viewer|ops|admin|remove], e.g. /invite @dawn viewer");
  const { actor, ws } = await asAdmin(ctx, slug);
  const username = user.replace(/^@/, "");
  const m = await setRole(ctx.db, actor, {
    workspaceId: ws.id,
    person: { username },
    role: role === "remove" ? null : (role as keyof typeof ROLE_WORD),
  });
  if (!m) return say(ctx, `${tag(ws)}@${esc(username)} no longer has access to ${esc(ws.name)}.`);
  const [p] = await ctx.db.select().from(people).where(eq(people.id, m.personId));
  const what = ROLE_WORD[m.role as keyof typeof ROLE_WORD];
  return {
    send: [
      ...say(ctx, `${tag(ws)}@${esc(username)} is now ${what} in ${esc(ws.name)}. I've sent them how to log in.`).send,
      {
        chatId: p.telegramId,
        personId: p.id,
        kind: "reply",
        html:
          `You're now ${what} for the ${esc(ws.name)} shuttles.\n` +
          `Log in at ${origin()}/login (it confirms here in Telegram). Once logged in, the main page also shows the live map.`,
      },
    ],
  };
}

// ---------------------------------------------------------------- /notice wizard

const DUR = { "1h": "1 hour", "2h": "2 hours", "4h": "4 hours", eod: "Rest of today", none: "Until ended by hand" };
const SEV: Record<NoticeSeverity, string> = { info: "Info", heads_up: "Heads-up", urgent: "Urgent" };
const CH = { none: "Page only", sub: "Page + subscribers", grp: "Page + group", pin: "Page + group, pinned" };
const CH_CHANNELS: Record<keyof typeof CH, NoticeChannel[]> = {
  none: [],
  sub: ["subscribers"],
  grp: ["group"],
  pin: ["group_pin"],
};
const WHERE = { every: "Everywhere", sched: "Above the schedule", admin: "Admin only" };
const WHERE_PLACEMENT: Record<keyof typeof WHERE, NoticePlacement> = {
  every: "everywhere",
  sched: "schedule",
  admin: "admin",
};
const keyOf = <K extends string>(m: Record<K, string>, label: string | undefined) =>
  (Object.keys(m) as K[]).find((k) => m[k] === label);

/** The draft lives in the preview message's own text; `where` is a WHERE label or a spot's name. */
type Draft = {
  slug: string | null;
  text: string;
  where?: string;
  dur?: keyof typeof DUR;
  sev?: NoticeSeverity;
  ch?: keyof typeof CH;
};

function renderDraft(d: Draft, title = "New notice"): string {
  const f = (v: string | undefined) => esc(v ?? "…");
  return [
    ...(d.slug ? [`<i>${TEST_TAG}${esc(d.slug)}</i>`] : []),
    `<b>${title}</b>`,
    esc(d.text),
    "",
    `Where: ${f(d.where)}`,
    `For: ${f(d.dur && DUR[d.dur])}`,
    `Severity: ${f(d.sev && SEV[d.sev])}`,
    `Send to: ${f(d.ch && CH[d.ch])}`,
  ].join("\n");
}

/** Read a draft back from Telegram's plain message text; null when it isn't one (e.g. already posted). */
function parseDraft(plain: string): Draft | null {
  const lines = plain.split("\n");
  const slug = lines[0]?.startsWith(TEST_TAG) ? (lines.shift() ?? "").slice(TEST_TAG.length) : null;
  if (lines[0] !== "New notice" || lines.length < 7) return null;
  const [where, dur, sev, ch] = lines.slice(-4).map((l) => {
    const v = l.slice(l.indexOf(": ") + 2);
    return v === "…" ? undefined : v;
  });
  return {
    slug,
    text: lines.slice(1, -5).join("\n"),
    where,
    dur: keyOf(DUR, dur),
    sev: keyOf(SEV, sev),
    ch: keyOf(CH, ch),
  };
}

/** Buttons for the first unanswered step, then Post; always Cancel. */
async function wizardButtons(ctx: BotContext, actor: Actor, ws: Workspace, d: Draft): Promise<TelegramButton[][]> {
  const row = <K extends string>(step: string, m: Record<K, string>) =>
    (Object.keys(m) as K[]).map((k) => [btn(m[k], "nw", step, k)]);
  const rows = !d.where
    ? [
        ...row("pl", WHERE),
        ...(await listSpots(ctx.db, actor, { workspaceId: ws.id })).map((s) => [btn(s.name, "nw", "pl", s.id)]),
      ]
    : !d.dur
      ? row("du", DUR)
      : !d.sev
        ? row("sv", SEV)
        : !d.ch
          ? row("ch", CH)
          : [[btn("Post notice", "nw", "post")]];
  return [...rows, [btn("Cancel", "nw", "x")]];
}

/**
 * `/notice <text>`: a wizard over buttons (placement → duration → severity → channels → Post), editing one
 * preview message. Stateless: the draft is read back from the preview message's own text at each step, choices
 * ride in callback data. Post → notices.createNotice. ops+.
 */
export async function onNotice(ctx: BotContext, text: string): Promise<BotReply> {
  const body = text.replace(/^\/notice(@\w+)?/i, "").trim();
  if (!body) return say(ctx, "Write the notice after the command, e.g.\n/notice Pickup is at the side gate today");
  if (body.length > 1000) return say(ctx, "That's too long: keep a notice under 1000 characters.");
  const { actor, ws } = await asAdmin(ctx, null);
  requireRole(actor, ws.id, "ops");
  const d: Draft = { slug: ws.isLive ? null : ws.slug, text: body };
  return say(ctx, renderDraft(d), await wizardButtons(ctx, actor, ws, d));
}

async function onWizard(ctx: BotContext, cb: Callback, q: TgCallbackQuery): Promise<BotReply> {
  const d = q.message?.text ? parseDraft(q.message.text) : null;
  if (!d) return expired(q);
  const [step, value = ""] = cb.args;
  if (step === "x") return editTo(q, "Notice discarded.");
  const { actor, ws } = await asAdmin(ctx, d.slug);
  requireRole(actor, ws.id, "ops");
  const spots = () => listSpots(ctx.db, actor, { workspaceId: ws.id });

  if (step === "pl") {
    const w = WHERE[value as keyof typeof WHERE] ?? (await spots()).find((s) => s.id === value)?.name;
    if (!w) throw new ServiceError("NOT_FOUND", "That spot is gone. Start again with /notice.");
    d.where = w;
  } else if (step === "du" && value in DUR) d.dur = value as keyof typeof DUR;
  else if (step === "sv" && value in SEV) d.sev = value as NoticeSeverity;
  else if (step === "ch" && value in CH) d.ch = value as keyof typeof CH;
  else if (step === "post" && d.where && d.dur && d.sev && d.ch) {
    const wk = keyOf(WHERE, d.where);
    const spotId = wk ? null : (await spots()).find((s) => s.name === d.where)?.id;
    const placement: NoticePlacement | undefined = wk ? WHERE_PLACEMENT[wk] : spotId ? `spot:${spotId}` : undefined;
    if (!placement) throw new ServiceError("NOT_FOUND", "That spot is gone. Start again with /notice.");
    const ends =
      d.dur === "none"
        ? null
        : d.dur === "eod"
          ? istToEpoch(istDate(ctx.now), "23:59")
          : +ctx.now + Number.parseInt(d.dur, 10) * H;
    const { sev, ch } = d;
    // idempotent: a second press (or a Telegram retry) of the same draft finds the notice it already made
    const dup = await locked(ctx, `nw:${q.message?.chat.id}:${q.message?.message_id}`, async (db) => {
      const found = (await listNotices(db, actor, { workspaceId: ws.id })).some(
        (n) =>
          n.text === d.text &&
          n.createdByPersonId === ctx.person.id &&
          n.placements.length === 1 &&
          n.placements[0] === placement &&
          +n.createdAt > +ctx.now - 10 * 60_000,
      );
      if (!found)
        await createNotice(db, actor, {
          workspaceId: ws.id,
          text: d.text,
          severity: sev,
          placements: [placement],
          channels: CH_CHANNELS[ch],
          endsAt: ends == null ? null : new Date(ends).toISOString(),
        });
      return found;
    });
    return editTo(q, renderDraft(d, "Notice posted"), [], dup ? "Already posted." : "Posted.");
  }
  return editTo(q, renderDraft(d), await wizardButtons(ctx, actor, ws, d));
}

// ---------------------------------------------------------------- buttons

/**
 * The buttons on an ops alert (SPEC §6c), for svc-alerts' AlertEvent.buttons: "Nudge phone" · "Mute alert 1h" when
 * the problem has a phone (`kind` = the problem kind it mutes, default every kind), then "Open in admin"
 * (<origin>/admin/<page>?w=<slug>). Muting never touches the phone; pausing tracking is a separate, named button.
 */
export function alertButtons(o: {
  slug: string;
  page: string;
  deviceId?: string | null;
  kind?: string;
}): TelegramButton[][] {
  return [
    ...(o.deviceId
      ? [
          [
            btn("Nudge phone", "nudge", o.deviceId),
            btn("Mute alert 1h", "mute", o.deviceId, ...(o.kind ? [o.kind] : [])),
          ],
        ]
      : []),
    [{ text: "Open in admin", url: `${origin()}/admin/${o.page}?w=${encodeURIComponent(o.slug)}` }],
  ];
}

async function onPhoneButton(ctx: BotContext, cb: Callback, q: TgCallbackQuery): Promise<BotReply> {
  const id = cb.args[0] ?? "";
  const [dev] = Id.safeParse(id).success ? await ctx.db.select().from(devices).where(eq(devices.id, id)).limit(1) : [];
  if (!dev) return toast(q, "That phone no longer exists.");
  const actor = await actorIn(ctx, dev.workspaceId);
  const input = { workspaceId: dev.workspaceId, deviceId: dev.id };
  // a Telegram/Traccar phone has no app to tap Resume in: ops resumes it from here or the admin page
  const outside = isOutsideApp(dev);
  const killed = outside
    ? `${esc(dev.label)} is killed. It has no app, so it stays off until you tap Resume tracking.`
    : `${esc(dev.label)} is killed. It stays off until the driver taps Resume in the app.`;
  const killedButtons = outside ? [[btn("Resume tracking", "resume", dev.id)]] : [];

  switch (cb.action) {
    case "nudge":
      await nudgePhone(ctx.db, actor, input);
      return toast(q, `Nudged ${dev.label}: it will sync in a moment.`);
    case "mute":
    case "sil1h": {
      // "sil1h" is the old button on alerts already sent: it only mutes now (every kind of that phone), never pauses
      const kind = cb.action === "sil1h" ? MUTE_ALL : (cb.args[1] ?? MUTE_ALL);
      if (kind !== MUTE_ALL && !MUTABLE_KINDS.has(kind)) return expired(q);
      // lock on what the mute is keyed to (the vehicle for silent / off_route), so two phones of one vehicle can't race
      const entity = await muteEntityFor(ctx.db, dev.workspaceId, dev.id, kind);
      return locked(ctx, `mute:${entity}:${actor.id}`, async (db) => {
        const r = await muteAlert(db, actor, { ...input, kind }, ctx.now);
        const what = kind === MUTE_ALL ? "alerts" : `${KIND_WORDS[kind] ?? kind} alerts`;
        return toast(
          q,
          `${r.already ? "Already muted" : "Muted"} ${what} for ${dev.label} until ${when(r.until, ctx.now)}. Tracking is unchanged.`,
        );
      });
    }
    case "pause1h": {
      // a repeat press while an hour-ish pause is already running changes nothing
      return locked(ctx, `pause1h:${dev.id}`, async (db) => {
        const [cur] = await db
          .select()
          .from(directives)
          .where(
            and(
              eq(directives.deviceId, dev.id),
              eq(directives.kind, "silence_until"),
              isNull(directives.cancelledAt),
              lte(directives.startsAt, ctx.now),
              gte(directives.endsAt, new Date(+ctx.now + 55 * 60_000)),
            ),
          )
          .orderBy(desc(directives.endsAt))
          .limit(1);
        if (cur) return toast(q, `Tracking is already paused until ${when(cur.endsAt, ctx.now)}.`);
        const until = new Date(+ctx.now + H);
        await silencePhone(db, actor, { ...input, until: until.toISOString() });
        return toast(
          q,
          `Paused tracking on ${dev.label} until ${when(until, ctx.now)}. It sends no location until then.`,
        );
      });
    }
    case "kill":
      requireRole(actor, dev.workspaceId, "admin");
      if (dev.killedAt) return toast(q, "Already killed.");
      return editTo(
        q,
        `<b>Kill ${esc(dev.label)}?</b>\nIt stops sharing location until ${
          outside ? "the shuttle team resumes it (it has no app)" : "the driver taps Resume in the app"
        }.`,
        [[btn("Yes, kill", "killok", dev.id), btn("Cancel", "noop")]],
      );
    case "resume":
      requireRole(actor, dev.workspaceId, "admin");
      if (!dev.killedAt) return toast(q, "Not killed.");
      if (!outside) return toast(q, "Only the driver can resume this phone, with Resume in the app.");
      // a repeat press (double tap, Telegram retry) waits for the first and finds the phone no longer killed
      return locked(ctx, `resume:${dev.id}`, async (db) => {
        const [cur] = await db.select({ killedAt: devices.killedAt }).from(devices).where(eq(devices.id, dev.id));
        if (!cur?.killedAt) return toast(q, "Not killed.");
        await resumePhone(db, actor, input);
        return editTo(q, `${esc(dev.label)} is resumed. It tracks again from its next update.`, [], "Resumed.");
      });
    default: // killok
      if (dev.killedAt) return editTo(q, killed, killedButtons, "Already killed.");
      await killPhone(ctx.db, actor, input);
      return editTo(q, killed, killedButtons, "Killed.");
  }
}

async function onCancelDay(ctx: BotContext, cb: Callback, q: TgCallbackQuery): Promise<BotReply> {
  const [serviceId = "", ymd = ""] = cb.args;
  const date = /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}` : null;
  const [svc] =
    date && Id.safeParse(serviceId).success
      ? await ctx.db.select().from(services).where(eq(services.id, serviceId)).limit(1)
      : [];
  if (!svc || !date) return toast(q, "That service no longer exists.");
  const actor = await actorIn(ctx, svc.workspaceId);
  requireRole(actor, svc.workspaceId, "ops");
  const day = formatIst(istToEpoch(date, "12:00")).split(",")[0];

  if (cb.action === "cday")
    return editTo(
      q,
      `<b>Cancel ${esc(svc.name)} on ${day}?</b>\nEvery departure that day is cancelled; attendees see no shuttle for it.`,
      [[btn("Yes, cancel the day", "cdayok", svc.id, ymd), btn("Keep it", "noop")]],
    );
  try {
    await addException(ctx.db, actor, { workspaceId: svc.workspaceId, serviceId: svc.id, date, type: "cancel_day" });
  } catch (e) {
    // already cancelled (a repeat press): the outcome the person asked for
    if (!isServiceError(e) || e.code !== "CONFLICT") throw e;
  }
  return editTo(q, `${esc(svc.name)} is cancelled on ${day}.`, [], "Done.");
}

/**
 * Buttons nudge / mute (sil1h = legacy mute) / pause1h / kill → killok / resume (a killed Telegram/Traccar phone) /
 * cday → cdayok / nw / noop. Destructive ones (kill, cday) first edit the
 * message into "Are you sure?" with [Yes, kill] [Cancel]; only the *ok action changes anything.
 */
export async function onAdminCallback(ctx: BotContext, cb: Callback, query: TgCallbackQuery): Promise<BotReply> {
  try {
    switch (cb.action) {
      case "nudge":
      case "mute":
      case "pause1h":
      case "sil1h":
      case "kill":
      case "killok":
      case "resume":
        return await onPhoneButton(ctx, cb, query);
      case "cday":
      case "cdayok":
        return await onCancelDay(ctx, cb, query);
      case "nw":
        return await onWizard(ctx, cb, query);
      case "noop":
        return editTo(query, "OK, nothing changed.");
      default:
        return expired(query);
    }
  } catch (e) {
    if (!isServiceError(e)) throw e;
    return toast(query, userMessage(e), true);
  }
}
