/**
 * SPEC §7 phone checks (`pnpm test:ui`): every admin page and the public page in real Chrome at 390×844, against
 * `next dev` on a seeded clone of the local Docker test Postgres. playwright-core drives the installed Chrome
 * (channel "chrome"); browsers are never downloaded. Screenshots land in tests/e2e-ui/output/.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../../..", import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@tests": fileURLToPath(new URL("../../../../tests", import.meta.url)),
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
    },
  },
  test: {
    name: "ui",
    // ponytail: a rooted glob finds nothing when the repo path itself has a dot dir (.claude/worktrees)
    include: ["**/apps/web/tests/e2e-ui/*.ui.ts"],
    exclude: [".claude/**", "**/node_modules/**"],
    globalSetup: ["apps/web/tests/e2e-ui/global-setup.ts"],
    // one browser, one dev server: pages compile on first visit, so run them one after another
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
