import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Without this, vitest also collects the compiled copies of colocated
    // tests (e.g. dist/async.test.js) and runs them twice.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
