import { describe, expect, it } from "vitest";
import { leiden } from "../src/index.js";

// Placeholder for the end-to-end Leiden tests. The native implementation is
// not wired up yet, so for now we just assert that the API surface exists
// and that calling it fails loudly rather than silently. Once the native
// path lands, replace these with actual community-detection assertions
// (a tiny two-clique graph is the standard smoke test).

describe("leiden() — tiny graphs (placeholder)", () => {
  it("currently throws because the native call is not wired up", () => {
    expect(() =>
      leiden({
        nodeCount: 4,
        sources: new Uint32Array([0, 1, 2, 3]),
        targets: new Uint32Array([1, 0, 3, 2]),
      }),
    ).toThrow(/not wired up/);
  });
});
