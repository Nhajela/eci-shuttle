import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Any test that touches Postgres is named *.db.test.ts and runs in the `db` project, on this worker's own clone.
const DB_TESTS = ["**/*.db.test.ts"];
const EXCLUDE = [".claude/**", "**/node_modules/**", "**/.next/**", "**/dist/**", "apps/driver/**"];

export default defineConfig({
  resolve: {
    alias: {
      "@tests": fileURLToPath(new URL("./tests", import.meta.url)),
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["**/*.test.ts"], exclude: [...DB_TESTS, ...EXCLUDE] },
      },
      {
        extends: true,
        // each worker has its own cloned database, so files run in parallel (fileParallelism stays on)
        test: {
          name: "db",
          include: DB_TESTS,
          exclude: EXCLUDE,
          globalSetup: ["tests/global-setup.ts"],
          setupFiles: ["tests/setup-db.ts"],
          testTimeout: 15_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
