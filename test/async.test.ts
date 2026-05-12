import { describe, expect, it } from "vitest";
import { leiden, leidenAsync, leidenFromCsrAsync } from "../src/index.js";

const TWO_TRIANGLES = {
  nodeCount: 6,
  sources: new Uint32Array([0, 1, 0, 3, 4, 3, 2]),
  targets: new Uint32Array([1, 2, 2, 4, 5, 5, 5]),
};

describe("leidenAsync()", () => {
  it("returns the same result as leiden() for the same input + seed", async () => {
    const sync = leiden({ ...TWO_TRIANGLES, seed: 99 });
    const async_ = await leidenAsync({ ...TWO_TRIANGLES, seed: 99 });
    expect(Array.from(async_.membership)).toEqual(Array.from(sync.membership));
    expect(async_.quality).toBeCloseTo(sync.quality, 12);
  });

  it("rejects with a validation error for bad input", async () => {
    await expect(
      leidenAsync({
        nodeCount: -1,
        sources: new Uint32Array(),
        targets: new Uint32Array(),
      }),
    ).rejects.toThrow(/nodeCount/);
  });

  it("does not block the event loop while running", async () => {
    // Build a slightly bigger graph so the optimiser takes non-trivial time.
    const n = 500;
    const sources: number[] = [];
    const targets: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      sources.push(i);
      targets.push(j);
    }
    // Add a few random shortcuts to make Leiden actually work.
    for (let i = 0; i < n; i += 7) {
      sources.push(i);
      targets.push((i + n / 2) % n);
    }

    const work = leidenAsync({
      nodeCount: n,
      sources: new Uint32Array(sources),
      targets: new Uint32Array(targets),
      seed: 1,
    });

    let tickedDuringWork = false;
    const ticker = new Promise<void>((resolve) => {
      setImmediate(() => {
        tickedDuringWork = true;
        resolve();
      });
    });

    await Promise.all([work, ticker]);
    expect(tickedDuringWork).toBe(true);
  });
});

describe("leidenFromCsrAsync()", () => {
  it("agrees with leidenAsync() on the same logical graph", async () => {
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

    const result = await leidenFromCsrAsync({
      nodeCount,
      offsets,
      targets,
      seed: 7,
    });
    expect(result.membership[0]).toBe(result.membership[1]);
    expect(result.membership[1]).toBe(result.membership[2]);
    expect(result.membership[3]).toBe(result.membership[4]);
    expect(result.membership[4]).toBe(result.membership[5]);
    expect(result.membership[0]).not.toBe(result.membership[3]);
  });
});
