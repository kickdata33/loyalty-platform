import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Emulator/security-rules tests share one Firebase Emulator Suite instance (singleProjectMode
    // in firebase.json merges all project ids into one dataset) — run test files one at a time so
    // they can't interleave writes/reads against that shared emulator state.
    fileParallelism: false,
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // See tests/stubs/server-only-noop.ts for why this alias exists.
      "server-only": path.resolve(import.meta.dirname, "./tests/stubs/server-only-noop.ts"),
    },
  },
});
