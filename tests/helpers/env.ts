/** Tests only ever use the local Docker Postgres (`pnpm test-db`), never a remote database. */
export function testServerUrl(): string {
  const url = process.env.TEST_DATABASE_URL || "postgres://postgres@localhost:5547";
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]", "postgres"].includes(host))
    throw new Error(`TEST_DATABASE_URL must be a local Postgres, got host ${host}`);
  return url;
}

export function dbUrl(name: string): string {
  const u = new URL(testServerUrl());
  u.pathname = `/${name}`;
  return u.toString();
}

export const TEMPLATE_DB = "shuttle_test_template";
/** Namespaced by run so parallel runs (other worktrees) sharing one server never drop each other's clones. */
export const workerDbName = (runId: string | number, poolId: string | number) => `shuttle_test_${runId}_${poolId}`;
