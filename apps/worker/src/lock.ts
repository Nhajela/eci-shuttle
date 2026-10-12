import type postgres from "postgres";

/**
 * Run fn while holding the session-level Postgres advisory lock `name` (on one reserved connection), or skip
 * when another session holds it. The lock is released even when fn throws (the error is rethrown).
 */
export async function withAdvisoryLock<T>(
  sql: postgres.Sql,
  name: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  // session locks belong to a connection, so lock and unlock must use the same one
  const conn = await sql.reserve();
  try {
    const [r] = await conn`select pg_try_advisory_lock(hashtext(${name})) as locked`;
    if (!r?.locked) return { ran: false };
    try {
      return { ran: true, value: await fn() };
    } finally {
      await conn`select pg_advisory_unlock(hashtext(${name}))`;
    }
  } finally {
    conn.release();
  }
}
