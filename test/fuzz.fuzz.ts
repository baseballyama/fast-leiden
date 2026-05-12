// Long-running fuzz of the JS/C++ boundary. Excluded from the default
// `pnpm test` run (the file extension `.fuzz.ts` is not picked up by
// vitest's default `**/*.test.ts` glob); the nightly CI workflow runs
// it via `vitest run --config vitest.fuzz.config.ts` so it runs with
// `numRuns` bumped well above the property suite's default and against
// the ASan/UBSan-instrumented addon.
//
// What we're guarding: the validator surface in `src/index.ts` and
// `native/binding.cc`. The Leiden algorithm itself is upstream's
// responsibility; we only care that *any* shape the public API
// accepts produces a well-formed result, and that *any* shape it
// rejects throws a JS error instead of corrupting memory.

import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { leiden, leidenAsync, leidenFromCsr } from "../src/index.js";

// Bump numRuns aggressively when the env var is present. The nightly
// workflow sets it to 5000; locally `pnpm fuzz` defaults to 1000 so
// developers can sanity-check the property in under a minute.
const NUM_RUNS = Number.parseInt(process.env.FAST_LEIDEN_FUZZ_RUNS ?? "1000", 10);
const fcOpts = { numRuns: NUM_RUNS };

// --- valid edge-list -----------------------------------------------------

const validEdgeList = fc.integer({ min: 1, max: 50 }).chain((nodeCount) =>
  fc.record({
    nodeCount: fc.constant(nodeCount),
    edges: fc.array(
      fc.tuple(
        fc.integer({ min: 0, max: nodeCount - 1 }),
        fc.integer({ min: 0, max: nodeCount - 1 }),
      ),
      { maxLength: 250 },
    ),
    seed: fc.integer({ min: 0, max: 0xffffffff }),
    directed: fc.boolean(),
    qualityFunction: fc.constantFrom("modularity", "cpm"),
    resolution: fc.double({ min: 0, max: 5, noNaN: true }),
    maxIterations: fc.integer({ min: 1, max: 8 }),
    withWeights: fc.boolean(),
  }),
);

describe(`fuzz: valid edge-list (${NUM_RUNS} runs)`, () => {
  test.prop([validEdgeList], fcOpts)("produces a well-formed partition", (input) => {
    const sources = new Uint32Array(input.edges.map(([s]) => s));
    const targets = new Uint32Array(input.edges.map(([, t]) => t));
    const weights = input.withWeights
      ? new Float64Array(input.edges.length).map((_, i) => (i % 5) * 0.25)
      : undefined;
    const result = leiden({
      nodeCount: input.nodeCount,
      sources,
      targets,
      weights,
      seed: input.seed,
      directed: input.directed,
      qualityFunction: input.qualityFunction,
      resolution: input.resolution,
      maxIterations: input.maxIterations,
    });
    expect(result.membership.length).toBe(input.nodeCount);
    expect(Number.isFinite(result.quality)).toBe(true);
    for (const c of result.membership) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(input.nodeCount);
    }
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });
});

// --- async path ----------------------------------------------------------

describe(`fuzz: async path matches sync output (${Math.min(NUM_RUNS, 200)} runs)`, () => {
  // Async runs are heavier; cap independently of NUM_RUNS so a 5000-run
  // nightly doesn't take an hour just to re-confirm sync == async.
  test.prop([validEdgeList], { numRuns: Math.min(NUM_RUNS, 200) })(
    "deterministic seed yields identical membership",
    async (input) => {
      const sources = new Uint32Array(input.edges.map(([s]) => s));
      const targets = new Uint32Array(input.edges.map(([, t]) => t));
      const opts = {
        nodeCount: input.nodeCount,
        sources,
        targets,
        seed: input.seed,
        qualityFunction: input.qualityFunction,
        resolution: input.resolution,
      };
      const sync = leiden(opts);
      const asyncResult = await leidenAsync(opts);
      expect(Array.from(asyncResult.membership)).toEqual(Array.from(sync.membership));
    },
  );
});

// --- malformed CSR -------------------------------------------------------

const malformedCsr = fc.integer({ min: 1, max: 30 }).chain((nodeCount) =>
  fc.record({
    nodeCount: fc.constant(nodeCount),
    offsets: fc
      .array(fc.integer({ min: -10, max: 2000 }), {
        minLength: nodeCount + 1,
        maxLength: nodeCount + 1,
      })
      .map(
        (arr) =>
          // Uint32Array silently wraps negatives; we want to feed wrap-around
          // values to the validator on purpose, so leave them as-is.
          new Uint32Array(arr.map((v) => v >>> 0)),
      ),
    targets: fc
      .array(fc.integer({ min: 0, max: 100 }), { maxLength: 300 })
      .map((arr) => new Uint32Array(arr)),
  }),
);

describe(`fuzz: malformed CSR throws, never crashes (${NUM_RUNS} runs)`, () => {
  test.prop([malformedCsr], fcOpts)("validator catches every malformed shape", (input) => {
    // ASan/UBSan in CI is the real safety net here. The property is just:
    // either it throws, or it returns a well-formed result if the random
    // shape happened to land on a valid CSR.
    let threw = false;
    let result;
    try {
      result = leidenFromCsr(input);
    } catch {
      threw = true;
    }
    if (!threw) {
      expect(result).toBeDefined();
      expect(result!.membership.length).toBe(input.nodeCount);
    }
  });
});

// --- wrong typed-array element types ------------------------------------

describe(`fuzz: wrong TypedArray element type always throws (${NUM_RUNS} runs)`, () => {
  test.prop(
    [
      fc.integer({ min: 1, max: 20 }),
      fc.constantFrom("Int32", "Int8", "Uint8", "Uint16", "Float32", "Float64"),
      fc.constantFrom("Int32", "Int8", "Uint8", "Uint16", "Float32", "Uint32"),
    ],
    fcOpts,
  )("any non-Uint32 / non-Float64 view throws", (n, sourcesKind, weightsKind) => {
    // If sourcesKind happens to be Uint32 and weightsKind happens to be
    // Float64, the input is valid and the test is trivially true. We let
    // fast-check explore both halves of the space.
    const ctor: Record<string, Uint8ArrayConstructor | Float32ArrayConstructor> = {
      Int32: Int32Array as unknown as Uint8ArrayConstructor,
      Int8: Int8Array as unknown as Uint8ArrayConstructor,
      Uint8: Uint8Array,
      Uint16: Uint16Array as unknown as Uint8ArrayConstructor,
      Float32: Float32Array as unknown as Uint8ArrayConstructor,
      Float64: Float64Array as unknown as Uint8ArrayConstructor,
      Uint32: Uint32Array as unknown as Uint8ArrayConstructor,
    };
    const sources = new ctor[sourcesKind]!(n) as unknown as Uint32Array;
    const targets = new Uint32Array(n);
    const weights = new ctor[weightsKind]!(n) as unknown as Float64Array;
    const isValid = sourcesKind === "Uint32" && weightsKind === "Float64";
    if (isValid) {
      // The validator should accept this shape; the fuzz isn't about it.
      return;
    }
    expect(() => leiden({ nodeCount: n, sources, targets, weights })).toThrow();
  });
});
