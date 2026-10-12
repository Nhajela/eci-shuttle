import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** A database handle or an open transaction: services accept either, so they compose inside one transaction. */
export type Db = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

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
    handle = createDb(url);
  }
  return handle;
}

/** The process-wide handle. Lazily created so builds don't need DATABASE_URL. */
export const db = (): Db => shared().db;

/** The raw postgres-js client behind db(): for advisory locks (worker) and health checks only. */
export const rawSql = (): postgres.Sql => shared().sql;
