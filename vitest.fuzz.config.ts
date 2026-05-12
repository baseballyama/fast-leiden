import { defineConfig } from "vitest/config";

// Vitest config for the long-running fuzz suite. The default `pnpm test`
// run uses `vitest.config.ts`, which only picks up `**/*.test.ts`; the
// fuzz files live alongside as `*.fuzz.ts` so they don't run on every
// commit. The nightly fuzz workflow drives this config explicitly.

export default defineConfig({
  test: {
    include: ["test/**/*.fuzz.ts"],
    environment: "node",
    // Each fuzz file may sit in a `test.prop([...], { numRuns: 5000 })`
    // for a while. Pick a generous timeout so the suite doesn't get
    // killed on a slow CI runner.
    testTimeout: 600_000,
    hookTimeout: 60_000,
    pool: "forks",
    fileParallelism: false,
    sequence: {
      concurrent: false,
      shuffle: false,
    },
  },
});
