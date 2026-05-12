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

  // NaN / Infinity weights propagate into libleidenalg and surface as
  // quality=NaN, which silently corrupts the result. Reject at the boundary.
  it("rejects NaN in weights", () => {
    expect(() =>
      leiden({
        nodeCount: 2,
        sources: new Uint32Array([0]),
        targets: new Uint32Array([1]),
        weights: new Float64Array([Number.NaN]),
      }),
    ).toThrow(/weights\[0\] must be finite/);
  });

  it("rejects Infinity in weights", () => {
    expect(() =>
      leiden({
        nodeCount: 2,
        sources: new Uint32Array([0]),
        targets: new Uint32Array([1]),
        weights: new Float64Array([Number.POSITIVE_INFINITY]),
      }),
    ).toThrow(/weights\[0\] must be finite/);
  });

  it("rejects -Infinity in weights, regardless of position", () => {
    expect(() =>
      leiden({
        nodeCount: 2,
        sources: new Uint32Array([0, 1]),
        targets: new Uint32Array([1, 0]),
        weights: new Float64Array([1.0, Number.NEGATIVE_INFINITY]),
      }),
    ).toThrow(/weights\[1\] must be finite/);
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

  // Without this check, a non-zero offsets[0] could let the native side write
  // past the start of the sources buffer.
  it("rejects offsets that do not start at 0", () => {
    expect(() =>
      leidenFromCsr({
        nodeCount: 2,
        offsets: new Uint32Array([1, 1, 1]),
        targets: new Uint32Array([0]),
      }),
    ).toThrow(/offsets\[0\] must be 0/);
  });

  // The dangerous case: an offset decreases and then the per-row loop in C++
  // writes job.sources[e] = v at e < start, blowing past the resized buffer.
  it("rejects non-monotonic offsets", () => {
    expect(() =>
      leidenFromCsr({
        nodeCount: 3,
        offsets: new Uint32Array([0, 2, 1, 3]),
        targets: new Uint32Array([0, 0, 0]),
      }),
    ).toThrow(/non-decreasing/);
  });

  it("rejects an interior offset that exceeds offsets[-1]", () => {
    expect(() =>
      leidenFromCsr({
        nodeCount: 2,
        offsets: new Uint32Array([0, 99, 1]),
        targets: new Uint32Array([0]),
      }),
    ).toThrow(/non-decreasing|exceeds/);
  });

  it("rejects NaN in CSR weights", () => {
    expect(() =>
      leidenFromCsr({
        nodeCount: 2,
        offsets: new Uint32Array([0, 1, 1]),
        targets: new Uint32Array([1]),
        weights: new Float64Array([Number.NaN]),
      }),
    ).toThrow(/weights\[0\] must be finite/);
  });
});

describe("leiden() seed validation", () => {
  // Uint32Value() on the native side would silently coerce these into wrong
  // seeds, breaking the determinism contract.
  it("rejects a negative seed", () => {
    expect(() =>
      leiden({
        nodeCount: 2,
        sources: new Uint32Array([0]),
        targets: new Uint32Array([1]),
        seed: -1,
      }),
    ).toThrow(/seed/);
  });

  it("rejects a fractional seed", () => {
    expect(() =>
      leiden({
        nodeCount: 2,
        sources: new Uint32Array([0]),
        targets: new Uint32Array([1]),
        seed: 1.5,
      }),
    ).toThrow(/seed/);
  });

  it("rejects NaN as a seed", () => {
    expect(() =>
      leiden({
        nodeCount: 2,
        sources: new Uint32Array([0]),
        targets: new Uint32Array([1]),
        seed: Number.NaN,
      }),
    ).toThrow(/seed/);
  });

  it("rejects a seed above 2^32 - 1", () => {
    expect(() =>
      leiden({
        nodeCount: 2,
        sources: new Uint32Array([0]),
        targets: new Uint32Array([1]),
        seed: 2 ** 32,
      }),
    ).toThrow(/seed/);
  });
});
