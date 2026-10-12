/** Runs in each db-project worker before each file: point the app's db() at this worker's clone. */
import { afterAll, inject } from "vitest";
import { dbUrl, workerDbName } from "./helpers/env";

process.env.DATABASE_URL = dbUrl(workerDbName(inject("shuttleRunId"), process.env.VITEST_POOL_ID ?? "1"));
process.env.SESSION_SECRET ||= "test-session-secret-at-least-32-chars-long";
process.env.PUBLIC_ORIGIN ||= "http://localhost:3000";

afterAll(async () => {
  const { closeTestDb } = await import("./helpers/db");
  await closeTestDb();
});
