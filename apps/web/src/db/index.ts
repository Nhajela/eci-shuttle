import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** A database handle or an open transaction: services accept either, so they compose inside one transaction. */
export type Db = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

/** Pool size from DB_POOL_MAX (a whole number 1..500); unset is 10, an invalid value warns (once: db() is created once) and is 10. The worker image sets 20 (start.sh). */
export function poolMax(raw: string | undefined = process.env.DB_POOL_MAX): number {
  if (raw === undefined || raw.trim() === "") return 10;
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0;
  if (n >= 1 && n <= 500) return n;
  console.warn(`DB_POOL_MAX=${JSON.stringify(raw)} is not a whole number from 1 to 500: using 10`);
  return 10;
}

export function createDb(
  url: string,
  opts: { max?: number } = {},
): { db: Db; sql: postgres.Sql; close: () => Promise<void> } {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), sql, close: () => sql.end({ timeout: 5 }) };
}

let handle: ReturnType<typeof createDb> | null = null;

function shared() {
  if (!handle) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    handle = createDb(url, { max: poolMax() });
  }
  return handle;
}

/** The process-wide handle. Lazily created so builds don't need DATABASE_URL. */
export const db = (): Db => shared().db;

/** The raw postgres-js client behind db(): for advisory locks (worker) and health checks only. */
export const rawSql = (): postgres.Sql => shared().sql;
