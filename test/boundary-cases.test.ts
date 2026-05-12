import { describe, expect, it } from "vitest";
import { leiden, leidenFromCsr } from "../src/index.js";

// Inputs that are "valid but weird": isolated nodes, self-loops, multi-edges,
// empty graphs, a graph with edges but no community structure. These exist to
// pin down the public-API contract documented in the README — the goal isn't
// to assert any specific partition (Leiden has many equally-good options on
// degenerate inputs), only that the addon returns a well-formed result and
// doesn't crash.

const assertValidResult = (result: { membership: Uint32Array; quality: number }, n: number) => {
  expect(result.membership).toBeInstanceOf(Uint32Array);
  expect(result.membership.length).toBe(n);
  expect(Number.isFinite(result.quality)).toBe(true);
  for (const c of result.membership) {
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThan(n);
  }
};

describe("leiden() — boundary inputs", () => {
  it("accepts an empty graph (nodeCount > 0, edges = 0)", () => {
    const n = 5;
    const result = leiden({
      nodeCount: n,
      sources: new Uint32Array(),
      targets: new Uint32Array(),
      seed: 1,
    });
    assertValidResult(result, n);
    // Each isolated node becomes its own community under modularity.
    expect(new Set(result.membership).size).toBe(n);
  });

  it("accepts isolated nodes alongside a connected component", () => {
    //  0 - 1 - 2     3   4   (3 and 4 are isolated)
    const result = leiden({
      nodeCount: 5,
      sources: new Uint32Array([0, 1]),
      targets: new Uint32Array([1, 2]),
      seed: 1,
    });
    assertValidResult(result, 5);
    // 0, 1, 2 should land in the same community.
    expect(result.membership[0]).toBe(result.membership[1]);
    expect(result.membership[1]).toBe(result.membership[2]);
    // 3 and 4 are isolated — neither should sit in the connected component.
    expect(result.membership[3]).not.toBe(result.membership[0]);
    expect(result.membership[4]).not.toBe(result.membership[0]);
  });

  it("accepts a graph containing self-loops", () => {
    // Two triangles + self-loop on node 0. The self-loop must not crash the
    // addon and must not move node 0 out of its triangle.
    const result = leiden({
      nodeCount: 6,
      sources: new Uint32Array([0, 1, 0, 3, 4, 3, 2, 0]),
      targets: new Uint32Array([1, 2, 2, 4, 5, 5, 5, 0]),
      seed: 42,
    });
    assertValidResult(result, 6);
    expect(result.membership[0]).toBe(result.membership[1]);
    expect(result.membership[0]).toBe(result.membership[2]);
    expect(result.membership[3]).toBe(result.membership[4]);
    expect(result.membership[3]).toBe(result.membership[5]);
    expect(result.membership[0]).not.toBe(result.membership[3]);
  });

  it("accepts a graph containing multi-edges", () => {
    // Edge (0,1) appears three times. Multi-edges effectively re-weight the
    // edge; the result should still be a valid partition.
    const result = leiden({
      nodeCount: 4,
      sources: new Uint32Array([0, 0, 0, 1, 2, 3]),
      targets: new Uint32Array([1, 1, 1, 2, 3, 0]),
      seed: 7,
    });
    assertValidResult(result, 4);
  });

  it("accepts nodeCount: 0 with no edges", () => {
    const result = leiden({
      nodeCount: 0,
      sources: new Uint32Array(),
      targets: new Uint32Array(),
    });
    expect(result.membership).toEqual(new Uint32Array());
    expect(Number.isFinite(result.quality)).toBe(true);
  });

  it("treats weight=0 edges as effectively absent", () => {
    // Two triangles bridged by a weight-0 edge. Modularity should still split
    // the triangles — a zero-weight edge contributes nothing to modularity.
    const result = leiden({
      nodeCount: 6,
      sources: new Uint32Array([0, 1, 0, 3, 4, 3, 2]),
      targets: new Uint32Array([1, 2, 2, 4, 5, 5, 5]),
      weights: new Float64Array([1, 1, 1, 1, 1, 1, 0]),
      seed: 42,
    });
    assertValidResult(result, 6);
    expect(result.membership[0]).not.toBe(result.membership[3]);
  });
});

describe("leidenFromCsr() — boundary inputs", () => {
  it("accepts an empty CSR graph (no edges)", () => {
    const n = 4;
    const result = leidenFromCsr({
      nodeCount: n,
      offsets: new Uint32Array(n + 1),
      targets: new Uint32Array(),
      seed: 1,
    });
    assertValidResult(result, n);
    expect(new Set(result.membership).size).toBe(n);
  });

  it("accepts isolated nodes in CSR form", () => {
    // Nodes 0..2 form a triangle; nodes 3 and 4 are isolated.
    const result = leidenFromCsr({
      nodeCount: 5,
      offsets: new Uint32Array([0, 2, 4, 6, 6, 6]),
      targets: new Uint32Array([1, 2, 0, 2, 0, 1]),
      seed: 1,
    });
    assertValidResult(result, 5);
    expect(result.membership[0]).toBe(result.membership[1]);
    expect(result.membership[1]).toBe(result.membership[2]);
  });

  it("accepts CSR with weight=0 edges", () => {
    const result = leidenFromCsr({
      nodeCount: 3,
      offsets: new Uint32Array([0, 1, 2, 3]),
      targets: new Uint32Array([1, 2, 0]),
      weights: new Float64Array([0, 0, 0]),
      seed: 1,
    });
    assertValidResult(result, 3);
  });
});
