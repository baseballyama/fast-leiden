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
