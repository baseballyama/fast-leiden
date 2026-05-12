import { describe, expect, it } from "vitest";
import { leiden } from "../src/index.js";

// Placeholder for weighted-edge tests. Replace once the native call is in.

describe("leiden() — weighted edges (placeholder)", () => {
  it("accepts a Float64Array of weights without TS-side validation errors", () => {
    expect(() =>
      leiden({
        nodeCount: 3,
        sources: new Uint32Array([0, 1, 2]),
        targets: new Uint32Array([1, 2, 0]),
        weights: new Float64Array([1.0, 2.0, 0.5]),
      }),
    ).toThrow(/not wired up/);
  });
});
