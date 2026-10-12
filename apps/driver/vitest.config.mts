import { defineConfig } from "vitest/config";

// Pure logic only; anything importing react-native stays out of these tests.
export default defineConfig({
  test: { include: ["**/*.test.ts"], exclude: ["**/node_modules/**", "android/**"] },
});
