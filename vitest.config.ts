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
    // Coverage gate. The TypeScript wrapper layer is small and almost all
    // of it is reachable from the public API, so we hold it to a high bar.
    // `native/binding.cc` is excluded — V8 coverage only sees JS; the C++
    // boundary is exercised by the test suite (incl. ASan/UBSan) and the
    // fast-check property fuzz, not by a line-coverage tool.
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["src/**/*.ts"],
      // types.ts is pure type declarations — V8 coverage reports it as
      // 100% empty, which skews the file count without telling us anything.
      exclude: ["src/types.ts"],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 90,
        branches: 80,
      },
    },
  },
});
