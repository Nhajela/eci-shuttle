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
 * - workspaces `eci-main` (live: phones paired into it are what attendees see) and `test`, when missing;
 * - admin in every workspace for each Telegram username in BOOTSTRAP_ADMINS (comma-separated, @ optional),
 *   once that person exists (they have messaged the bot or logged in). Restart web after their first login.
 */
const SEED = [
  { slug: "eci-main", name: "ECI Main", isLive: true },
  { slug: "test", name: "Test", isLive: false },
];

async function bootstrap(sql: postgres.Sql) {
  await sql.begin(async (q) => {
    const tx = q as unknown as postgres.Sql;
    const audit = (ws: string, action: string, entity: string, entityId: string, after: unknown) =>
      tx`insert into audit_log (workspace_id, actor_kind, actor_id, actor_label, channel, action, entity, entity_id, after, reason)
         values (${ws}, 'system', 'bootstrap', 'bootstrap', 'worker', ${action}, ${entity}, ${entityId}, ${JSON.stringify(after)}::jsonb, 'first-run bootstrap')`;
    const [hasLive] = await tx`select 1 from workspaces where is_live`;
    for (const w of SEED) {
      const isLive = w.isLive && !hasLive;
      const made = await tx`insert into workspaces (slug, name, is_live) values (${w.slug}, ${w.name}, ${isLive})
                            on conflict (slug) do nothing returning id`;
      if (made.length) {
        await audit(made[0].id, "workspace.create", "workspace", made[0].id, { ...w, isLive });
        console.log(`bootstrap: workspace ${w.slug}${isLive ? " (live)" : ""}`);
      }
    }
    const names = (process.env.BOOTSTRAP_ADMINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean);
    if (!names.length) return;
    const all = await tx`select id, slug from workspaces`;
    for (const name of names) {
      const people = await tx`select id from people where lower(username) = ${name}`;
      for (const p of people) {
        for (const ws of all) {
          const added =
            await tx`insert into memberships (person_id, workspace_id, role) values (${p.id}, ${ws.id}, 'admin')
                                 on conflict (person_id, workspace_id) do nothing returning id`;
          if (added.length) {
            await audit(ws.id, "membership.create", "membership", added[0].id, { personId: p.id, role: "admin" });
            console.log(`bootstrap: @${name} is admin of ${ws.slug}`);
          }
        }
      }
    }
  });
}

main().catch((e) => {
  console.error("migration failed", e);
  process.exit(1);
});
