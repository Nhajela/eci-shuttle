/**
 * Once per `pnpm test:ui`: clone a fresh database from the shared test template on the local Docker Postgres
 * (tests/global-setup.ts), seed it, start `next dev` against it, and mint an admin session cookie
 * (services/auth/session.signSession). The tests get the origin and cookie through `inject()`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import baseSetup from "@tests/global-setup";
import { dbUrl, workerDbName } from "@tests/helpers/env";
import type { TestProject } from "vitest/node";
import { createDb } from "@/db";
import { SESSION_COOKIE, signSession } from "@/services/auth/session";
import { seed } from "./seed";

declare module "vitest" {
  interface ProvidedContext {
    uiOrigin: string;
    uiSession: { name: string; value: string };
    uiSlug: string;
  }
}

const PORT = 3000 + 100 + (process.pid % 800);
const ORIGIN = `http://localhost:${PORT}`;
const WEB = fileURLToPath(new URL("../..", import.meta.url));

async function waitForServer(server: ChildProcess, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`next dev exited with ${server.exitCode}`);
    try {
      if ((await fetch(`${ORIGIN}/api/status`)).status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`next dev did not answer on ${ORIGIN} within ${ms} ms`);
}

function kill(server: ChildProcess) {
  if (server.exitCode !== null || !server.pid) return;
  // next dev spawns children; on Windows only taskkill /T takes the whole tree down
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(-server.pid, "SIGTERM");
}

export default async function setup(project: TestProject) {
  let runId = "";
  const dropDb = await baseSetup({
    config: { maxWorkers: 1 },
    provide: (_k: string, v: string) => {
      runId = v;
    },
  } as unknown as TestProject);
  const env = {
    DATABASE_URL: dbUrl(workerDbName(runId, 1)),
    PUBLIC_ORIGIN: ORIGIN,
    SESSION_SECRET: "ui-test-session-secret-at-least-32-chars",
    TOKEN_SECRETS: "ui-test-token-secret-at-least-32-characters",
    TELEGRAM_BOT_TOKEN: "0:ui-test",
    TELEGRAM_BOT_USERNAME: "eci_shuttle_ui_test_bot",
    TELEGRAM_WEBHOOK_SECRET: "ui-test-webhook-secret",
  };
  Object.assign(process.env, env); // the services read origin()/secrets while seeding

  const h = createDb(env.DATABASE_URL, { max: 2 });
  const { slug, personId } = await seed(h.db).finally(() => h.close());

  const server = spawn("pnpm", ["exec", "next", "dev", "--port", String(PORT)], {
    cwd: WEB,
    env: { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: "1" },
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
  });
  try {
    await waitForServer(server, 120_000);
  } catch (e) {
    kill(server);
    await dropDb();
    throw e;
  }

  project.provide("uiOrigin", ORIGIN);
  project.provide("uiSlug", slug);
  project.provide("uiSession", {
    name: SESSION_COOKIE,
    value: signSession({ personId, issuedAt: Date.now() }, env.SESSION_SECRET),
  });

  return async () => {
    kill(server);
    await dropDb(); // DROP ... WITH (FORCE) closes the server's connections
  };
}
