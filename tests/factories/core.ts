/** Core factories (foundation-owned). Modules add their own in tests/factories/<module>.ts. */
import { randomUUID } from "node:crypto";
import type { Role } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import { memberships, people, workspaces } from "@/db/schema";
import type { Actor } from "@/services/kernel";

/** A fresh workspace with a unique slug: tests in one worker share a database, so each test makes its own. */
export async function makeWorkspace(db: Db, over: Partial<typeof workspaces.$inferInsert> = {}) {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const [w] = await db
    .insert(workspaces)
    .values({ slug, name: `Test ${slug}`, ...over })
    .returning();
  return w;
}

let tg = 1_000_000;
export async function makePerson(db: Db, over: Partial<typeof people.$inferInsert> = {}) {
  const [p] = await db
    .insert(people)
    .values({ telegramId: tg++ + Math.floor(Math.random() * 1e9), firstName: "Test", ...over })
    .returning();
  return p;
}

/** A person with a membership, and the Actor an adapter would build for them. */
export async function makeAdmin(db: Db, workspaceId: string, role: Role = "admin", channel: Actor["channel"] = "web") {
  const person = await makePerson(db);
  await db.insert(memberships).values({ personId: person.id, workspaceId, role });
  const actor: Actor = { kind: "admin", id: person.id, workspaceId, role, channel, label: person.firstName ?? "admin" };
  return { person, actor };
}
