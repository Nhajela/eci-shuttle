/**
 * Applies the drizzle SQL migrations (apps/web/drizzle, copied to /app/drizzle in the image) before web starts.
 * An advisory lock makes concurrent starts (web redeploy + worker) wait instead of racing.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const MIGRATE_LOCK = 7_301_001;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${MIGRATE_LOCK})`;
    await migrate(drizzle(sql), { migrationsFolder: process.env.MIGRATIONS_DIR ?? "./drizzle" });
    console.log("migrations applied");
    await bootstrap(sql);
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATE_LOCK})`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

/**
 * First-run bootstrap, idempotent and audited as `system`:
 * - a live workspace `main` when none exists (phones paired into it are what attendees see);
 * - admin in the live workspace for each Telegram username in BOOTSTRAP_ADMINS (comma-separated, no @),
 *   once that person exists (they have messaged the bot or logged in). Restart web after their first login.
 */
async function bootstrap(sql: postgres.Sql) {
  const audit = (
    q: postgres.Sql,
    ws: string | null,
    action: string,
    entity: string,
    entityId: string,
    after: unknown,
  ) =>
    q`insert into audit_log (workspace_id, actor_kind, actor_id, actor_label, channel, action, entity, entity_id, after, reason)
        values (${ws}, 'system', 'bootstrap', 'bootstrap', 'worker', ${action}, ${entity}, ${entityId}, ${q.json(after as never)}, 'first-run bootstrap')`;
  await sql.begin(async (tx) => {
    const [live] = await tx`select id from workspaces where is_live`;
    let wsId = live?.id as string | undefined;
    if (!wsId) {
      const [ws] = await tx`insert into workspaces (slug, name, is_live) values ('main', 'Main', true)
                            on conflict (slug) do update set is_live = true returning id`;
      wsId = ws.id as string;
      await audit(tx as unknown as postgres.Sql, wsId, "workspace.create", "workspace", wsId, {
        slug: "main",
        name: "Main",
        isLive: true,
      });
      console.log("bootstrap: live workspace main");
    }
    const names = (process.env.BOOTSTRAP_ADMINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean);
    for (const name of names) {
      const people = await tx`select id from people where lower(username) = ${name}`;
      for (const p of people) {
        const added =
          await tx`insert into memberships (person_id, workspace_id, role) values (${p.id}, ${wsId}, 'admin')
                               on conflict (person_id, workspace_id) do nothing returning id`;
        if (added.length) {
          await audit(tx as unknown as postgres.Sql, wsId, "membership.create", "membership", added[0].id, {
            personId: p.id,
            role: "admin",
          });
          console.log(`bootstrap: @${name} is admin of the live workspace`);
        }
      }
    }
  });
}

main().catch((e) => {
  console.error("migration failed", e);
  process.exit(1);
});
