/** svc-notices: notices, placed and pinned (SPEC §6b). ops+ writes, viewer+ admin reads, public reads via activeNotices. */
import {
  IST_TZ,
  NoticeCreateFields,
  NoticeEndFields,
  type NoticePlacement,
  SEVERITY_RANK,
  withWorkspace,
} from "@eci-shuttle/shared";
import { and, arrayContains, arrayOverlaps, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { notices, people, services, spots, subscriptions, workspaces } from "@/db/schema";
import type { Notice } from "@/db/types";
import {
  type Actor,
  checkVersion,
  enqueue,
  getInWorkspace,
  inWorkspace,
  mutate,
  parseInput,
  readable,
  requireRole,
  ServiceError,
  systemActor,
} from "../kernel";

export const CreateNoticeInput = withWorkspace(NoticeCreateFields);
export const EndNoticeInput = withWorkspace(NoticeEndFields);
export const UpdateNoticeInput = z.object({
  workspaceId: z.uuid(),
  noticeId: z.uuid(),
  version: z.number().int().positive().optional(),
  text: z.string().trim().min(1).max(1000).optional(),
  pinned: z.boolean().optional(),
  sort: z.number().int().optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

const JOB = systemActor("notices");

/** Over at `now`: ended by hand, or past its end time. */
const isOver = (n: Notice, now: Date) =>
  (n.endedAt != null && n.endedAt <= now) || (n.endsAt != null && n.endsAt <= now);

/** Display order (SPEC §6b): pinned first by sort, then severity (urgent first), then newest. */
export function compareNotices(a: Notice, b: Notice): number {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    (a.pinned ? a.sort - b.sort : 0) ||
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.startsAt.getTime() - a.startsAt.getTime() ||
    b.createdAt.getTime() - a.createdAt.getTime()
  );
}

function checkEnd(startsAt: Date, endsAt: Date | null, now: Date): void {
  if (endsAt && endsAt <= startsAt) throw new ServiceError("INVALID", "The end must be after the start.");
  if (endsAt && endsAt <= now) throw new ServiceError("INVALID", "The end is already in the past.");
}

/** ids referenced by `prefix:<uuid>` placements */
const refs = (placements: readonly string[], prefix: "spot" | "service") =>
  placements.filter((p) => p.startsWith(`${prefix}:`)).map((p) => p.slice(prefix.length + 1));

/**
 * ops+. spot:/service: placements must reference this workspace's spots/services (INVALID otherwise);
 * endsAt > startsAt. Channels are sent by the notices job at startsAt, not here. Audited notice.create.
 */
export async function createNotice(db: Db, actor: Actor, input: z.input<typeof CreateNoticeInput>): Promise<Notice> {
  const i = parseInput(CreateNoticeInput, input);
  requireRole(actor, i.workspaceId, "ops");
  const now = new Date();
  const startsAt = i.startsAt ? new Date(i.startsAt) : now;
  const endsAt = i.endsAt ? new Date(i.endsAt) : null;
  checkEnd(startsAt, endsAt, now);
  const placements = [...new Set(i.placements)];

  return mutate(db, actor, { action: "notice.create", entity: "notice", workspaceId: i.workspaceId }, async (tx) => {
    for (const [prefix, table] of [
      ["spot", spots],
      ["service", services],
    ] as const) {
      const ids = refs(placements, prefix);
      if (!ids.length) continue;
      const found = await tx
        .select({ id: table.id })
        .from(table)
        .where(and(inWorkspace(table, i.workspaceId), inArray(table.id, ids)));
      if (found.length !== ids.length)
        throw new ServiceError("INVALID", `That ${prefix} isn't in this workspace.`, {
          missing: ids.filter((id) => !found.some((f) => f.id === id)),
        });
    }
    const [row] = await tx
      .insert(notices)
      .values({
        workspaceId: i.workspaceId,
        text: i.text,
        severity: i.severity,
        pinned: i.pinned,
        sort: i.sort,
        startsAt,
        endsAt,
        placements,
        channels: [...new Set(i.channels)],
        createdByPersonId: actor.kind === "admin" ? actor.id : null,
      })
      .returning();
    return { before: null, after: row, result: row };
  });
}

/** ops+. Text/pin/sort/end edits; placements and channels are fixed once created. */
export async function updateNotice(db: Db, actor: Actor, input: z.input<typeof UpdateNoticeInput>): Promise<Notice> {
  const i = parseInput(UpdateNoticeInput, input);
  requireRole(actor, i.workspaceId, "ops");
  return mutate(
    db,
    actor,
    { action: "notice.update", entity: "notice", entityId: i.noticeId, workspaceId: i.workspaceId },
    async (tx) => {
      const before = await getInWorkspace(tx, notices, i.workspaceId, i.noticeId, "notice", { forUpdate: true });
      checkVersion(before, i.version, "notice");
      const endsAt = i.endsAt === undefined ? before.endsAt : i.endsAt ? new Date(i.endsAt) : null;
      if (i.endsAt !== undefined) checkEnd(before.startsAt, endsAt, new Date());
      const [after] = await tx
        .update(notices)
        .set({
          text: i.text ?? before.text,
          pinned: i.pinned ?? before.pinned,
          sort: i.sort ?? before.sort,
          endsAt,
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(notices.id, before.id))
        .returning();
      return { before, after, result: after };
    },
  );
}

/** ops+. Sets ended_at = now; the notices job unpins it in the group. Audited notice.end. */
export async function endNotice(db: Db, actor: Actor, input: z.input<typeof EndNoticeInput>): Promise<Notice> {
  const i = parseInput(EndNoticeInput, input);
  requireRole(actor, i.workspaceId, "ops");
  return mutate(
    db,
    actor,
    { action: "notice.end", entity: "notice", entityId: i.noticeId, workspaceId: i.workspaceId },
    async (tx) => {
      const before = await getInWorkspace(tx, notices, i.workspaceId, i.noticeId, "notice", { forUpdate: true });
      if (before.endedAt) throw new ServiceError("CONFLICT", "This notice has already ended.");
      const now = new Date();
      const [after] = await tx
        .update(notices)
        .set({ endedAt: now, version: before.version + 1, updatedAt: now })
        .where(eq(notices.id, before.id))
        .returning();
      return { before, after, result: after };
    },
  );
}

/** viewer+. Current and upcoming first, then history (ended/expired) newest first. */
export async function listNotices(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; includeHistory?: boolean },
): Promise<Notice[]> {
  readable(actor, input.workspaceId);
  const now = new Date();
  // ponytail: loads the workspace's whole history; fine at event scale (hundreds), page it if that grows.
  const rows = await db.select().from(notices).where(inWorkspace(notices, input.workspaceId));
  const live = rows.filter((n) => !isOver(n, now)).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  if (!input.includeHistory) return live;
  const overAt = (n: Notice) => Math.min(n.endedAt?.getTime() ?? Infinity, n.endsAt?.getTime() ?? Infinity);
  return [...live, ...rows.filter((n) => isOver(n, now)).sort((a, b) => overAt(b) - overAt(a))];
}

/** started, not ended, not expired at `now` */
const showingAt = (now: Date) =>
  and(
    lte(notices.startsAt, now),
    or(isNull(notices.endedAt), gt(notices.endedAt, now)),
    or(isNull(notices.endsAt), gt(notices.endsAt, now)),
  );

/**
 * Notices showing at `now` (started, not ended, not expired), optionally only for some placements, ordered:
 * pinned first by sort, then severity (urgent first), then newest. No actor (public).
 * The placement filter is a plain overlap: the public page passes ["everywhere", "spot:<id>"] itself.
 */
export async function activeNotices(
  db: Db,
  workspaceId: string,
  now: Date,
  placements?: NoticePlacement[],
): Promise<Notice[]> {
  if (placements && !placements.length) return [];
  const rows = await db
    .select()
    .from(notices)
    .where(
      and(
        inWorkspace(notices, workspaceId),
        showingAt(now),
        placements ? arrayOverlaps(notices.placements, placements) : undefined,
      ),
    );
  return rows.sort(compareNotices);
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const istTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST_TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const LABEL = { urgent: "<b>Urgent:</b> ", heads_up: "<b>Heads up:</b> ", info: "" } as const;

/** The Telegram text of a notice (times in IST). */
export function noticeHtml(n: Pick<Notice, "text" | "severity" | "endsAt">): string {
  const until = n.endsAt ? `\n<i>Until ${istTime.format(n.endsAt)}</i>` : "";
  return `${LABEL[n.severity]}${escapeHtml(n.text)}${until}`;
}

/** Telegram chats of open `notices` subscribers who should get this notice (none for admin/schedule-only). */
async function recipients(db: Db, n: Notice): Promise<{ personId: string; chatId: number }[]> {
  const everywhere = n.placements.includes("everywhere");
  const spotIds = refs(n.placements, "spot");
  if (!everywhere && !spotIds.length) return [];
  return db
    .selectDistinct({ personId: people.id, chatId: people.telegramId })
    .from(subscriptions)
    .innerJoin(people, eq(people.id, subscriptions.personId))
    .where(
      and(
        inWorkspace(subscriptions, n.workspaceId),
        eq(subscriptions.kind, "notices"),
        isNull(subscriptions.firedAt),
        isNull(subscriptions.cancelledAt),
        isNull(people.blockedBotAt),
        everywhere ? undefined : or(isNull(subscriptions.spotId), inArray(subscriptions.spotId, spotIds)),
      ),
    );
}

/**
 * The notices job (every minute): for notices that started and have channels but no sent_at, queue Telegram
 * sends (subscribers of the placed spots, or all `notices` subscribers for `everywhere`; the group post, pinned
 * for group_pin) and set sent_at in the same transaction (dedupe keys per recipient). For ended/expired ones with
 * a group_message_id and no unpinned_at, queue the unpin and set unpinned_at. Returns counts.
 */
export async function runNoticeLifecycle(db: Db, now: Date): Promise<{ sent: number; unpinned: number }> {
  const due = await db
    .select({ n: notices, groupChatId: workspaces.groupChatId })
    .from(notices)
    .innerJoin(workspaces, eq(workspaces.id, notices.workspaceId))
    .where(and(isNull(notices.sentAt), sql`cardinality(${notices.channels}) > 0`, showingAt(now)));

  // ponytail: no row lock; a second concurrent run re-queues nothing (dedupe keys) but writes a second audit row.
  for (const { n, groupChatId } of due) {
    await mutate(db, JOB, { action: "notice.send", entity: "notice", workspaceId: n.workspaceId }, async (tx) => {
      const html = noticeHtml(n);
      if (n.channels.includes("subscribers"))
        for (const r of await recipients(tx, n))
          await enqueue(tx, {
            workspaceId: n.workspaceId,
            kind: "telegram",
            payload: { chatId: r.chatId, html, kind: "notice", personId: r.personId },
            dedupeKey: `notice:${n.id}:to:${r.personId}`,
          });
      const pin = n.channels.includes("group_pin");
      if (groupChatId != null && (pin || n.channels.includes("group")))
        await enqueue(tx, {
          workspaceId: n.workspaceId,
          kind: "telegram",
          payload: {
            chatId: groupChatId,
            html,
            kind: "notice",
            pin,
            ref: { kind: "notice_group_post", noticeId: n.id },
          },
          dedupeKey: `notice:${n.id}:group`,
        });
      const [after] = await tx.update(notices).set({ sentAt: now }).where(eq(notices.id, n.id)).returning();
      return { before: n, after, result: after };
    });
  }

  const over = await db
    .select({ n: notices, groupChatId: workspaces.groupChatId })
    .from(notices)
    .innerJoin(workspaces, eq(workspaces.id, notices.workspaceId))
    .where(
      and(
        isNotNull(notices.groupMessageId),
        isNull(notices.unpinnedAt),
        arrayContains(notices.channels, ["group_pin"]),
        or(lte(notices.endedAt, now), lte(notices.endsAt, now)),
      ),
    );
  for (const { n, groupChatId } of over) {
    await mutate(db, JOB, { action: "notice.unpin", entity: "notice", workspaceId: n.workspaceId }, async (tx) => {
      if (groupChatId != null && n.groupMessageId != null)
        await enqueue(tx, {
          workspaceId: n.workspaceId,
          kind: "telegram",
          payload: { chatId: groupChatId, html: "", kind: "notice", unpinMessageId: n.groupMessageId },
          dedupeKey: `notice:${n.id}:unpin`,
        });
      const [after] = await tx.update(notices).set({ unpinnedAt: now }).where(eq(notices.id, n.id)).returning();
      return { before: n, after, result: after };
    });
  }
  return { sent: due.length, unpinned: over.length };
}

/** Called by auth-bot's deliverTelegram after the group post went out (ref notice_group_post). */
export async function recordGroupPost(db: Db, noticeId: string, messageId: number): Promise<void> {
  const [n] = await db.select({ workspaceId: notices.workspaceId }).from(notices).where(eq(notices.id, noticeId));
  if (!n) throw new ServiceError("NOT_FOUND", "No such notice.", { entity: "notice", id: noticeId });
  await mutate(
    db,
    JOB,
    { action: "notice.group_post", entity: "notice", entityId: noticeId, workspaceId: n.workspaceId },
    async (tx) => {
      const before = await getInWorkspace(tx, notices, n.workspaceId, noticeId, "notice", { forUpdate: true });
      const [after] = await tx
        .update(notices)
        .set({ groupMessageId: messageId })
        .where(eq(notices.id, noticeId))
        .returning();
      return { before, after, result: undefined };
    },
  );
}
