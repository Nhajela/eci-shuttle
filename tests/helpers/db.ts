import { createDb, type Db } from "@/db";

let handle: { db: Db; close: () => Promise<void> } | null = null;

/** This worker's clone (see tests/global-setup.ts). Tables start empty; tests make their own rows. */
export function testDb(): Db {
  handle ??= createDb(process.env.DATABASE_URL as string, { max: 4 });
  return handle.db;
}

export async function closeTestDb() {
  await handle?.close();
  handle = null;
}
