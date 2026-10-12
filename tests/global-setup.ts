/**
 * Runs once in the main process. Builds shuttle_test_template from apps/web/src/db/schema.ts (only when the
 * schema hash changed), then gives every Vitest worker a fresh clone shuttle_test_<runId>_<VITEST_POOL_ID>.
 * Cloning a template is a file copy, so each run starts from empty tables without truncating.
 * tests/setup-db.ts points workers at their clone. runId keeps concurrent runs (several worktrees, one server)
 * out of each other's databases.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { dbUrl, TEMPLATE_DB, workerDbName } from "./helpers/env";

declare module "vitest" {
  interface ProvidedContext {
    shuttleRunId: string;
  }
}

const SCHEMA = "apps/web/src/db/schema.ts";

async function withSql<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function templateHash(): Promise<string | null> {
  try {
    return await withSql(dbUrl(TEMPLATE_DB), async (sql) => {
      const r = await sql`SELECT hash FROM _shuttle_schema_hash LIMIT 1`;
      return (r[0]?.hash as string) ?? null;
    });
  } catch {
    return null;
  }
}

/** Builds under a private name, then swaps it in, so a concurrent run never clones a half-built template. */
async function buildTemplate(hash: string) {
  const tmp = `shuttle_tpl_build_${process.pid}`;
  await withSql(dbUrl("postgres"), async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${tmp} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${tmp}`);
  });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  const schema = await import("../apps/web/src/db/schema");
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  await withSql(dbUrl(tmp), async (sql) => {
    for (const s of statements) await sql.unsafe(s);
    await sql`CREATE TABLE _shuttle_schema_hash (hash text not null)`;
    await sql`INSERT INTO _shuttle_schema_hash VALUES (${hash})`;
  });
  await withSql(dbUrl("postgres"), async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    try {
      await sql.unsafe(`ALTER DATABASE ${tmp} RENAME TO ${TEMPLATE_DB}`);
    } catch {
      await sql.unsafe(`DROP DATABASE IF EXISTS ${tmp}`); // another run swapped its build in first; same schema
    }
  });
}

export default async function setup(project: TestProject) {
  const hash = createHash("sha256").update(readFileSync(SCHEMA)).digest("hex");
  try {
    if ((await templateHash()) !== hash) await buildTemplate(hash);
  } catch (e) {
    throw new Error(`Test Postgres not reachable. Run \`pnpm test-db\` first. (${(e as Error).message})`);
  }

  const runId = String(process.pid);
  project.provide("shuttleRunId", runId);
  const workers = Number(project.config.maxWorkers) || availableParallelism();
  const names = Array.from({ length: workers }, (_, i) => workerDbName(runId, i + 1));
  // Postgres clones from one template serially anyway
  await withSql(dbUrl("postgres"), async (sql) => {
    for (const name of names) {
      await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await sql.unsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
    }
  });

  return async () => {
    await withSql(dbUrl("postgres"), async (sql) => {
      for (const name of names) await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    });
  };
}
