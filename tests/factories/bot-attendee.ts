/** Factories for bot-attendee (subscriptions + bot attendee tests). */
import type { AnswerLine } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import { routes, services, spots } from "@/db/schema";
import type { Person } from "@/db/types";
import type { Actor } from "@/services/kernel";

export async function makeSpot(db: Db, workspaceId: string, over: Partial<typeof spots.$inferInsert> = {}) {
  const [s] = await db
    .insert(spots)
    .values({ workspaceId, name: "Riva Beach", shortName: "Riva", lat: 15.66, lng: 73.71, ...over })
    .returning();
  return s;
}

export async function makeService(db: Db, workspaceId: string, spotIds: string[], name = "To Circle") {
  const [r] = await db.insert(routes).values({ workspaceId, name: "R", spotIds }).returning();
  const [s] = await db
    .insert(services)
    .values({
      workspaceId,
      name,
      kind: "regular",
      routeId: r.id,
      validFrom: "2026-10-01",
      validTo: "2026-11-01",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: "08:00",
      endTime: "23:00",
      pattern: { kind: "every", everyMin: 30 },
    })
    .returning();
  return s;
}

export const attendee = (person: Person, workspaceId: string): Actor => ({
  kind: "attendee",
  id: person.id,
  workspaceId,
  channel: "telegram",
  label: person.firstName ?? "attendee",
});

const ID = "00000000-0000-4000-8000-000000000000";

export function line(over: Partial<AnswerLine> = {}): AnswerLine {
  return {
    serviceId: ID,
    serviceName: "To Circle",
    colour: null,
    kind: "live",
    minutes: 6,
    rangeLo: 5,
    rangeHi: 9,
    approx: false,
    nextAt: null,
    nextAtLabel: null,
    phaseText: "on the way",
    lastSeenS: 10,
    vehicleName: "Bus 1",
    notices: [],
    ...over,
  };
}
