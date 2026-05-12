import { describe, expect, it } from "vitest";
import { leiden, leidenFromCsr } from "../src/index.js";

describe("leiden() input validation", () => {
  it("rejects a negative nodeCount", () => {
    expect(() =>
      leiden({
        nodeCount: -1,
        sources: new Uint32Array([0]),
        targets: new Uint32Array([0]),
      }),
    ).toThrow(/nodeCount/);
  });

  it("rejects mismatched sources/targets lengths", () => {
    expect(() =>
      leiden({
        nodeCount: 3,
        sources: new Uint32Array([0, 1]),
        targets: new Uint32Array([1]),
      }),
    ).toThrow(/same length/);
  });

  it("rejects non-Uint32Array sources", () => {
    expect(() =>
      leiden({
        nodeCount: 2,
        // @ts-expect-error — wrong type is the point of this test
        sources: [0, 1],
        targets: new Uint32Array([1, 0]),
      }),
    ).toThrow(/Uint32Array/);
  });

  it("rejects weights with the wrong length", () => {
    expect(() =>
      leiden({
        nodeCount: 2,
        sources: new Uint32Array([0, 1]),
        targets: new Uint32Array([1, 0]),
        weights: new Float64Array([1.0]),
      }),
    ).toThrow(/weights length/);
  });

  it("rejects unknown qualityFunction values", () => {
    expect(() =>
      leiden({
        nodeCount: 2,
        sources: new Uint32Array([0]),
        targets: new Uint32Array([1]),
        // @ts-expect-error — wrong type is the point of this test
        qualityFunction: "bogus",
      }),
    ).toThrow(/qualityFunction/);
  });
});

describe("leidenFromCsr() input validation", () => {
  it("rejects offsets with the wrong length", () => {
    expect(() =>
      leidenFromCsr({
        nodeCount: 3,
        offsets: new Uint32Array([0, 1]),
        targets: new Uint32Array([1]),
      }),
    ).toThrow(/offsets length/);
  });

  it("rejects targets that disagree with offsets[-1]", () => {
    expect(() =>
      leidenFromCsr({
        nodeCount: 2,
        offsets: new Uint32Array([0, 1, 2]),
        targets: new Uint32Array([1]),
      }),
    ).toThrow(/targets length/);
  });
});
