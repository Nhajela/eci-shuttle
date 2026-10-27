import { istDate } from "@eci-shuttle/shared";
import { type AnyColumn, and, inArray, isNull, lt, or } from "drizzle-orm";
import type { Db } from "@/db";
import { loginCodes, outbox, pairingCodes, pings, proposals } from "@/db/schema";
import { mutate, systemActor } from "@/services/kernel";

const DAY = 86_400_000;

/** coalesce(col, fallback) < cut, with typed params (a raw sql Date param breaks postgres-js). */
const olderThan = (col: AnyColumn, fallback: AnyColumn, cut: Date) =>
  or(lt(col, cut), and(isNull(col), lt(fallback, cut)));

/**
 * Nightly cleanup (SPEC §2b, run by the worker job at 03:30 IST): delete login codes, pairing codes and proposals expired more than a day ago, and
 * outbox rows sent/dead more than 14 days ago. After the event (PINGS_DELETE_AFTER, the last IST date whose pings are kept, in env; unset =
 * keep: the purge starts the day after) delete raw pings: the phones belong to the drivers (SPEC §4). Deleting expired credentials is
 * bookkeeping, not audited; the ping purge writes one audit row (pings.purge, system actor) with the count.
 * Confirmed proposals are kept: audit rows point at them.
 */
export async function runCleanup(db: Db, pingsDeleteAfter: string | undefined, now: Date) {
  const dayAgo = new Date(+now - DAY);
  const n = async (q: Promise<unknown[]>) => (await q).length;
  const counts = {
    loginCodes: await n(
      db
        .delete(loginCodes)
        .where(olderThan(loginCodes.expiresAt, loginCodes.createdAt, dayAgo))
        .returning({ c: loginCodes.code }),
    ),
    pairingCodes: await n(
      db.delete(pairingCodes).where(lt(pairingCodes.expiresAt, dayAgo)).returning({ c: pairingCodes.code }),
    ),
    proposals: await n(
      db
        .delete(proposals)
        .where(and(lt(proposals.expiresAt, dayAgo), isNull(proposals.confirmedAt)))
        .returning({ c: proposals.id }),
    ),
    outbox: await n(
      db
        .delete(outbox)
        .where(
          and(
            inArray(outbox.status, ["sent", "dead"]),
            olderThan(outbox.sentAt, outbox.createdAt, new Date(+now - 14 * DAY)),
          ),
        )
        .returning({ c: outbox.id }),
    ),
    pings: 0,
  };
  // IST calendar days compare as ISO strings; skip an empty table so later nights write no audit row
  if (pingsDeleteAfter && istDate(now) > pingsDeleteAfter && (await db.select().from(pings).limit(1)).length) {
    counts.pings = await mutate(
      db,
      systemActor("cleanup"),
      { action: "pings.purge", entity: "pings", workspaceId: null },
      async (tx) => {
        const { count } = await tx.delete(pings);
        return { before: null, after: { count, from: pingsDeleteAfter }, result: count };
      },
    );
  }
  return counts;
}
