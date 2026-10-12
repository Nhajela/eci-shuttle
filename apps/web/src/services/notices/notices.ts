/** svc-notices: notices, placed and pinned (SPEC §6b). ops+ writes, viewer+ admin reads, public reads via activeNotices. */
import {
  NoticeCreateFields,
  NoticeEndFields,
  type NoticePlacement,
  notImplemented,
  withWorkspace,
} from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { Notice } from "@/db/types";
import type { Actor } from "../kernel";

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

/**
 * ops+. spot:/service: placements must reference this workspace's spots/services (INVALID otherwise);
 * endsAt > startsAt. Channels are sent by the notices job at startsAt, not here. Audited notice.create.
 */
export async function createNotice(db: Db, actor: Actor, input: z.input<typeof CreateNoticeInput>): Promise<Notice> {
  return notImplemented(db, actor, input);
}

/** ops+. Text/pin/sort/end edits; placements and channels are fixed once created. */
export async function updateNotice(db: Db, actor: Actor, input: z.input<typeof UpdateNoticeInput>): Promise<Notice> {
  return notImplemented(db, actor, input);
}

/** ops+. Sets ended_at = now; the notices job unpins it in the group. Audited notice.end. */
export async function endNotice(db: Db, actor: Actor, input: z.input<typeof EndNoticeInput>): Promise<Notice> {
  return notImplemented(db, actor, input);
}

/** viewer+. Current and upcoming first, then history (ended/expired) newest first. */
export async function listNotices(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; includeHistory?: boolean },
): Promise<Notice[]> {
  return notImplemented(db, actor, input);
}

/**
 * Notices showing at `now` (started, not ended, not expired), optionally only for some placements, ordered:
 * pinned first by sort, then severity (urgent first), then newest. No actor (public).
 */
export async function activeNotices(
  db: Db,
  workspaceId: string,
  now: Date,
  placements?: NoticePlacement[],
): Promise<Notice[]> {
  return notImplemented(db, workspaceId, now, placements);
}

/**
 * The notices job (every minute): for notices that started and have channels but no sent_at, queue Telegram
 * sends (subscribers of the placed spots, or all `notices` subscribers for `everywhere`; the group post, pinned
 * for group_pin) and set sent_at in the same transaction (dedupe keys per recipient). For ended/expired ones with
 * a group_message_id and no unpinned_at, queue the unpin and set unpinned_at. Returns counts.
 */
export async function runNoticeLifecycle(db: Db, now: Date): Promise<{ sent: number; unpinned: number }> {
  return notImplemented(db, now);
}

/** Called by auth-bot's deliverTelegram after the group post went out (ref notice_group_post). */
export async function recordGroupPost(db: Db, noticeId: string, messageId: number): Promise<void> {
  return notImplemented(db, noticeId, messageId);
}
