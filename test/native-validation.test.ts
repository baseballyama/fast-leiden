import { describe, expect, it } from "vitest";
import { native } from "../src/native.js";

// These tests exercise the native addon directly, bypassing the TS validation
// layer in src/index.ts. They guard against regressions where a caller who
// resolves the native binding (or a deep `dist/native.js` import) drives the
// addon into silent corruption: nodeCount: 1.5 used to be accepted, NaN
// resolution used to surface as quality=NaN, and maxIterations: 0 used to
// return an un-improved partition with iterations: 0.

const validEdgeListBase = () => ({
  nodeCount: 2,
  sources: new Uint32Array([0]),
  targets: new Uint32Array([1]),
});

const validCsrBase = () => ({
  nodeCount: 2,
  offsets: new Uint32Array([0, 1, 1]),
  targets: new Uint32Array([1]),
});

describe("native.leidenFromEdgeList — boundary validation", () => {
  it("rejects a fractional nodeCount", () => {
    expect(() => native.leidenFromEdgeList({ ...validEdgeListBase(), nodeCount: 1.5 })).toThrow(
      /nodeCount/,
    );
  });

  it("rejects a negative nodeCount", () => {
    expect(() => native.leidenFromEdgeList({ ...validEdgeListBase(), nodeCount: -1 })).toThrow(
      /nodeCount/,
    );
  });

  it("rejects NaN nodeCount", () => {
    expect(() =>
      native.leidenFromEdgeList({ ...validEdgeListBase(), nodeCount: Number.NaN }),
    ).toThrow(/nodeCount/);
  });

  it("rejects maxIterations: 0", () => {
    expect(() => native.leidenFromEdgeList({ ...validEdgeListBase(), maxIterations: 0 })).toThrow(
      /maxIterations/,
    );
  });

  it("rejects a fractional maxIterations", () => {
    expect(() => native.leidenFromEdgeList({ ...validEdgeListBase(), maxIterations: 1.5 })).toThrow(
      /maxIterations/,
    );
  });

  it("rejects NaN resolution", () => {
    expect(() =>
      native.leidenFromEdgeList({ ...validEdgeListBase(), resolution: Number.NaN }),
    ).toThrow(/resolution/);
  });

  it("rejects a negative resolution", () => {
    expect(() => native.leidenFromEdgeList({ ...validEdgeListBase(), resolution: -0.5 })).toThrow(
      /resolution/,
    );
  });

  it("rejects a fractional seed even when called natively", () => {
    expect(() => native.leidenFromEdgeList({ ...validEdgeListBase(), seed: 1.5 })).toThrow(/seed/);
  });
});

describe("native.leidenFromCsr — boundary validation", () => {
  it("rejects a fractional nodeCount", () => {
    expect(() => native.leidenFromCsr({ ...validCsrBase(), nodeCount: 1.5 })).toThrow(/nodeCount/);
  });

  it("rejects a negative nodeCount", () => {
    expect(() => native.leidenFromCsr({ ...validCsrBase(), nodeCount: -1 })).toThrow(/nodeCount/);
  });

  it("rejects NaN resolution", () => {
    expect(() => native.leidenFromCsr({ ...validCsrBase(), resolution: Number.NaN })).toThrow(
      /resolution/,
    );
  });

  it("rejects maxIterations: 0", () => {
    expect(() => native.leidenFromCsr({ ...validCsrBase(), maxIterations: 0 })).toThrow(
      /maxIterations/,
    );
  });
});

describe("native.leidenFromEdgeListAsync — boundary validation", () => {
  it("rejects a fractional nodeCount via promise rejection", async () => {
    await expect(
      native.leidenFromEdgeListAsync({ ...validEdgeListBase(), nodeCount: 1.5 }),
    ).rejects.toThrow(/nodeCount/);
  });

  it("rejects NaN resolution via promise rejection", async () => {
    await expect(
      native.leidenFromEdgeListAsync({ ...validEdgeListBase(), resolution: Number.NaN }),
    ).rejects.toThrow(/resolution/);
  });
});

// IsTypedArray() returns true for every typed view (Uint8Array, Float32Array,
// …), so the previous code happily `As<Uint32Array>()`-cast a Uint8Array,
// aliasing the underlying buffer at the wrong stride. These tests pin the
// fix: a wrong-element-type TypedArray is now a TypeError, not silent
// corruption.
describe("native.leidenFromEdgeList — TypedArray element type", () => {
  it("rejects Uint8Array sources", () => {
    expect(() =>
      native.leidenFromEdgeList({
        nodeCount: 2,
        // @ts-expect-error — wrong typed-array type is exactly what we test
        sources: new Uint8Array([0]),
        targets: new Uint32Array([1]),
      }),
    ).toThrow(/Uint32Array/);
  });

  it("rejects Uint8Array targets", () => {
    expect(() =>
      native.leidenFromEdgeList({
        nodeCount: 2,
        sources: new Uint32Array([0]),
        // @ts-expect-error
        targets: new Uint8Array([1]),
      }),
    ).toThrow(/Uint32Array/);
  });

  it("rejects Int32Array sources", () => {
    expect(() =>
      native.leidenFromEdgeList({
        nodeCount: 2,
        // @ts-expect-error
        sources: new Int32Array([0]),
        targets: new Uint32Array([1]),
      }),
    ).toThrow(/Uint32Array/);
  });

  it("rejects Float32Array weights", () => {
    expect(() =>
      native.leidenFromEdgeList({
        nodeCount: 2,
        sources: new Uint32Array([0]),
        targets: new Uint32Array([1]),
        // @ts-expect-error
        weights: new Float32Array([1.0]),
      }),
    ).toThrow(/Float64Array/);
  });
});

describe("native.leidenFromCsr — TypedArray element type", () => {
  it("rejects Uint8Array offsets", () => {
    expect(() =>
      native.leidenFromCsr({
        nodeCount: 2,
        // @ts-expect-error
        offsets: new Uint8Array([0, 1, 1]),
        targets: new Uint32Array([1]),
      }),
    ).toThrow(/Uint32Array/);
  });

  it("rejects Float32Array weights on CSR", () => {
    expect(() =>
      native.leidenFromCsr({
        ...validCsrBase(),
        // @ts-expect-error
        weights: new Float32Array([1.0]),
      }),
    ).toThrow(/Float64Array/);
  });
});

// Negative weights are undefined for modularity and meaningless for CPM as
// implemented in libleidenalg. Reject them at the native boundary as well so a
// deep-import caller can't silently produce a junk partition.
describe("native — negative weights", () => {
  it("rejects negative weights on edge list", () => {
    expect(() =>
      native.leidenFromEdgeList({
        nodeCount: 2,
        sources: new Uint32Array([0]),
        targets: new Uint32Array([1]),
        weights: new Float64Array([-0.5]),
      }),
    ).toThrow(/non-negative/);
  });

  it("rejects negative weights on CSR", () => {
    expect(() =>
      native.leidenFromCsr({
        ...validCsrBase(),
        weights: new Float64Array([-1.0]),
      }),
    ).toThrow(/non-negative/);
  });
});
