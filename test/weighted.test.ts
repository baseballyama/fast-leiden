import { describe, expect, it } from "vitest";
import { leiden, leidenFromCsr } from "../src/index.js";

describe("leiden() — weighted edges", () => {
  it("respects edge weights when splitting communities", () => {
    // Two clusters of three nodes each. Inside each cluster the edges are
    // heavy; the single bridge between the clusters is light. Modularity
    // should put each cluster in its own community.
    const result = leiden({
      nodeCount: 6,
      sources: new Uint32Array([0, 1, 2, 3, 4, 5, 2]),
      targets: new Uint32Array([1, 2, 0, 4, 5, 3, 3]),
      weights: new Float64Array([10, 10, 10, 10, 10, 10, 0.01]),
      seed: 1,
    });

    expect(result.membership[0]).toBe(result.membership[1]);
    expect(result.membership[1]).toBe(result.membership[2]);
    expect(result.membership[3]).toBe(result.membership[4]);
    expect(result.membership[4]).toBe(result.membership[5]);
    expect(result.membership[0]).not.toBe(result.membership[3]);
  });
});

describe("leidenFromCsr()", () => {
  it("produces the same partition as leiden() for the same graph", () => {
    // Same two-triangle graph as the edge-list smoke test, encoded as CSR.
    const nodeCount = 6;
    const adjacency: Record<number, number[]> = {
      0: [1, 2],
      1: [0, 2],
      2: [0, 1, 5],
      3: [4, 5],
      4: [3, 5],
      5: [2, 3, 4],
    };
    const offsets = new Uint32Array(nodeCount + 1);
    const targetsList: number[] = [];
    for (let v = 0; v < nodeCount; v++) {
      offsets[v] = targetsList.length;
      const row = adjacency[v];
      if (row !== undefined) targetsList.push(...row);
    }
    offsets[nodeCount] = targetsList.length;
    const targets = new Uint32Array(targetsList);

    const result = leidenFromCsr({ nodeCount, offsets, targets, seed: 7 });

    expect(result.membership[0]).toBe(result.membership[1]);
    expect(result.membership[1]).toBe(result.membership[2]);
    expect(result.membership[3]).toBe(result.membership[4]);
    expect(result.membership[4]).toBe(result.membership[5]);
    expect(result.membership[0]).not.toBe(result.membership[3]);
  });
});
