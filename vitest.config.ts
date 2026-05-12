import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    // Run test files in separate worker processes (`forks`) and disable
    // file-level parallelism. Both knobs target the same hazard: the native
    // addon is loaded once per process, and igraph + libleidenalg keep
    // process-global state (the error handler, RNG seed, the mutex inside
    // RunLeidenJob). Running two test files in parallel inside one worker
    // would race that state and produce false reds / false greens that
    // don't reproduce locally.
    pool: "forks",
    fileParallelism: false,
    sequence: {
      // Run tests inside a single file sequentially too, so the order in the
      // file is the order at execution. Concurrent describe / it blocks are
      // a footgun for native-addon suites; the upside of test-level
      // parallelism is small for our O(ms) per-test cost.
      concurrent: false,
      // Keep file order deterministic so test logs match git diff order.
      shuffle: false,
    },
  },
});
