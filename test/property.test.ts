import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { leiden, leidenFromCsr } from "../src/index.js";

// Property tests for the public API. The goal is not to prove correctness of
// the Leiden algorithm — that's libleidenalg's responsibility — but to fuzz
// the JS/C++ boundary with shapes the hand-written tests don't cover and
// pin the contract documented in README → "API contract":
//
//   - For any valid input, the result is a well-formed partition.
//   - For any input that violates the contract, we throw a JS error rather
//     than crashing or corrupting memory.
//
// The native addon runs under ASan + UBSan in CI (see ci.yml), so any
// out-of-bounds access during these random runs will be reported there.

// --- generators ------------------------------------------------------------

// Build a random valid edge list. We deliberately allow self-loops,
// multi-edges, isolated nodes, and zero-weight edges — all part of the
// supported input contract.
const edgeListArbitrary = fc.integer({ min: 1, max: 30 }).chain((nodeCount) =>
  fc.record({
    nodeCount: fc.constant(nodeCount),
    edges: fc.array(
      fc.tuple(
        fc.integer({ min: 0, max: nodeCount - 1 }),
        fc.integer({ min: 0, max: nodeCount - 1 }),
      ),
      { maxLength: 100 },
    ),
    weights: fc.option(fc.boolean(), { freq: 2 }),
    seed: fc.integer({ min: 0, max: 0xffff }),
    qualityFunction: fc.constantFrom("modularity", "cpm"),
    resolution: fc.double({ min: 0, max: 5, noNaN: true }),
  }),
);

const csrArbitrary = fc.integer({ min: 1, max: 30 }).chain((nodeCount) =>
  fc
    .array(fc.array(fc.integer({ min: 0, max: nodeCount - 1 }), { maxLength: 8 }), {
      minLength: nodeCount,
      maxLength: nodeCount,
    })
    .map((rows) => {
      const offsets = new Uint32Array(nodeCount + 1);
      const targets: number[] = [];
      for (let i = 0; i < nodeCount; i++) {
        offsets[i] = targets.length;
        targets.push(...(rows[i] ?? []));
      }
      offsets[nodeCount] = targets.length;
      return { nodeCount, offsets, targets: new Uint32Array(targets) };
    }),
);

// Generate a CSR shape that's "almost valid" but breaks one invariant the
// validator must catch. We never want this to crash — only throw.
const malformedCsrArbitrary = fc
  .integer({ min: 1, max: 20 })
  .chain((nodeCount) =>
    fc.record({
      nodeCount: fc.constant(nodeCount),
      offsets: fc.array(fc.integer({ min: 0, max: 200 }), {
        minLength: nodeCount + 1,
        maxLength: nodeCount + 1,
      }),
      targets: fc
        .array(fc.integer({ min: 0, max: nodeCount - 1 }), { maxLength: 200 })
        .map((arr) => new Uint32Array(arr)),
    }),
  )
  .map(({ nodeCount, offsets, targets }) => ({
    nodeCount,
    offsets: new Uint32Array(offsets),
    targets,
  }))
  // Drop the rare case where the random shape happens to satisfy every CSR
  // invariant; this property is specifically about *malformed* CSR.
  .filter(({ nodeCount, offsets, targets }) => {
    if (offsets[0] !== 0) return true;
    for (let i = 1; i <= nodeCount; i++) {
      const prev = offsets[i - 1]!;
      const cur = offsets[i]!;
      if (cur < prev) return true;
      if (cur > 1000) return true;
    }
    return offsets[nodeCount] !== targets.length;
  });

// --- properties ------------------------------------------------------------

describe("property: leiden() returns a well-formed partition for valid input", () => {
  test.prop([edgeListArbitrary])("invariants hold", (input) => {
    const sources = new Uint32Array(input.edges.map(([s]) => s));
    const targets = new Uint32Array(input.edges.map(([, t]) => t));
    const weights = input.weights
      ? new Float64Array(input.edges.map(([, , w]) => (typeof w === "number" ? w : 1)))
      : undefined;
    const result = leiden({
      nodeCount: input.nodeCount,
      sources,
      targets,
      weights,
      seed: input.seed,
      qualityFunction: input.qualityFunction,
      resolution: input.resolution,
    });
    expect(result.membership).toBeInstanceOf(Uint32Array);
    expect(result.membership.length).toBe(input.nodeCount);
    expect(Number.isFinite(result.quality)).toBe(true);
    for (const c of result.membership) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(input.nodeCount);
    }
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });
});

describe("property: leidenFromCsr() returns a well-formed partition for valid CSR", () => {
  test.prop([csrArbitrary])("invariants hold", ({ nodeCount, offsets, targets }) => {
    const result = leidenFromCsr({ nodeCount, offsets, targets, seed: 1 });
    expect(result.membership.length).toBe(nodeCount);
    expect(Number.isFinite(result.quality)).toBe(true);
    for (const c of result.membership) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(nodeCount);
    }
  });
});

describe("property: leiden() with deterministic seed is reproducible", () => {
  test.prop([edgeListArbitrary])("two runs with the same seed agree", (input) => {
    const sources = new Uint32Array(input.edges.map(([s]) => s));
    const targets = new Uint32Array(input.edges.map(([, t]) => t));
    const a = leiden({
      nodeCount: input.nodeCount,
      sources,
      targets,
      seed: input.seed,
      qualityFunction: input.qualityFunction,
      resolution: input.resolution,
    });
    const b = leiden({
      nodeCount: input.nodeCount,
      sources,
      targets,
      seed: input.seed,
      qualityFunction: input.qualityFunction,
      resolution: input.resolution,
    });
    expect(Array.from(a.membership)).toEqual(Array.from(b.membership));
    expect(a.quality).toBeCloseTo(b.quality, 12);
  });
});

describe("property: malformed CSR throws, never crashes", () => {
  test.prop([malformedCsrArbitrary])("validator catches every malformed shape", (input) => {
    // We don't care which specific error is thrown — only that the call does
    // not segfault, does not return a result, and surfaces a JS exception.
    // ASan/UBSan in CI is what really guards memory safety here.
    expect(() => leidenFromCsr(input)).toThrow();
  });
});

describe("property: non-Float64 weights are always rejected", () => {
  test.prop([fc.integer({ min: 1, max: 10 }), fc.constantFrom("Int32", "Uint8", "Float32")])(
    "any wrong typed-array element type throws",
    (n, kind) => {
      const sources = new Uint32Array(n).map((_, i) => i % n);
      const targets = new Uint32Array(n).map((_, i) => (i + 1) % n);
      const weightsCtor =
        kind === "Int32" ? Int32Array : kind === "Uint8" ? Uint8Array : Float32Array;
      const weights = new weightsCtor(n) as unknown as Float64Array;
      expect(() =>
        leiden({
          nodeCount: n,
          sources,
          targets,
          weights,
        }),
      ).toThrow();
    },
  );
});
