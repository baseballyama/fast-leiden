import { describe, expect, it } from "vitest";
import { leiden } from "../src/index.js";

// Two disjoint triangles connected by a single bridge edge. Leiden should
// recover the two triangles as separate communities under modularity.
//
//   0 - 1     3 - 4
//    \ /       \ /
//     2 ------- 5
//
const TWO_TRIANGLES = {
  nodeCount: 6,
  sources: new Uint32Array([0, 1, 0, 3, 4, 3, 2]),
  targets: new Uint32Array([1, 2, 2, 4, 5, 5, 5]),
};

describe("leiden() — two-triangle smoke test", () => {
  it("recovers two communities on two triangles joined by a bridge", () => {
    const result = leiden({ ...TWO_TRIANGLES, seed: 42 });

    expect(result.membership).toBeInstanceOf(Uint32Array);
    expect(result.membership.length).toBe(TWO_TRIANGLES.nodeCount);
    expect(typeof result.quality).toBe("number");
    expect(result.iterations).toBeGreaterThanOrEqual(1);

    // Nodes inside each triangle must share a community.
    expect(result.membership[0]).toBe(result.membership[1]);
    expect(result.membership[1]).toBe(result.membership[2]);
    expect(result.membership[3]).toBe(result.membership[4]);
    expect(result.membership[4]).toBe(result.membership[5]);

    // The two triangles should be in different communities.
    expect(result.membership[0]).not.toBe(result.membership[3]);
  });

  it("is deterministic for the same seed", () => {
    const a = leiden({ ...TWO_TRIANGLES, seed: 123 });
    const b = leiden({ ...TWO_TRIANGLES, seed: 123 });
    expect(Array.from(a.membership)).toEqual(Array.from(b.membership));
    expect(a.quality).toBeCloseTo(b.quality, 12);
  });

  it("handles a single-node graph with no edges", () => {
    const result = leiden({
      nodeCount: 1,
      sources: new Uint32Array(),
      targets: new Uint32Array(),
    });
    expect(result.membership).toEqual(new Uint32Array([0]));
  });
});
