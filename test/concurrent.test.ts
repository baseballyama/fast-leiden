import { describe, expect, it } from "vitest";
import { leiden, leidenAsync, leidenFromCsrAsync } from "../src/index.js";

// Concurrency tests for the async API.
//
// igraph's error-handling layer is not thread-safe (see
// vendor/igraph/include/igraph_error.h), so the native side serializes every
// call into igraph + libleidenalg behind a process-global mutex. These tests
// pin that contract: many async calls in flight at once must all complete,
// must all produce a valid partition, and (with the same seed) must all
// agree on the partition. Without the mutex, this test surfaces flakes or
// (under ASan/UBSan) explicit errors from the upstream error state racing.

const TRIANGLES = {
  nodeCount: 6,
  sources: new Uint32Array([0, 1, 0, 3, 4, 3, 2]),
  targets: new Uint32Array([1, 2, 2, 4, 5, 5, 5]),
};

describe("concurrent async — Promise.all", () => {
  it("8 simultaneous leidenAsync calls all succeed", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => leidenAsync({ ...TRIANGLES, seed: 42 })),
    );
    expect(results).toHaveLength(8);
    for (const r of results) {
      expect(r.membership.length).toBe(6);
      expect(Number.isFinite(r.quality)).toBe(true);
    }
    // Same seed → same partition across all parallel runs.
    const first = Array.from(results[0]!.membership);
    for (const r of results.slice(1)) {
      expect(Array.from(r.membership)).toEqual(first);
    }
  });

  it("32 simultaneous async calls don't crash and all return valid partitions", async () => {
    const promises = Array.from({ length: 32 }, (_, i) => leidenAsync({ ...TRIANGLES, seed: i }));
    const results = await Promise.all(promises);
    expect(results).toHaveLength(32);
    for (const r of results) {
      expect(r.membership.length).toBe(6);
      // Membership ids in valid range
      for (const c of r.membership) expect(c).toBeLessThan(6);
    }
  });

  it("sync calls interleaved with async calls produce consistent results", async () => {
    // Kick off async work, then run a sync call while it's in flight. The
    // mutex inside RunLeidenJob serializes the two; the sync call should
    // observe a coherent partition, not a partially-computed one.
    const asyncPromises: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      asyncPromises.push(leidenAsync({ ...TRIANGLES, seed: i + 1 }));
    }
    const syncResults = [];
    for (let i = 0; i < 8; i++) {
      syncResults.push(leiden({ ...TRIANGLES, seed: i + 100 }));
    }
    const asyncResults = await Promise.all(asyncPromises);
    expect(asyncResults).toHaveLength(8);
    expect(syncResults).toHaveLength(8);
    for (const r of [...asyncResults, ...syncResults]) {
      // @ts-expect-error — both are NativeLeidenResult-shaped
      expect(r.membership.length).toBe(6);
    }
  });

  it("CSR async calls in parallel also serialize correctly", async () => {
    const csr = {
      nodeCount: 6,
      offsets: new Uint32Array([0, 2, 4, 7, 9, 11, 14]),
      targets: new Uint32Array([1, 2, 0, 2, 0, 1, 5, 4, 5, 3, 5, 2, 3, 4]),
    };
    const promises = Array.from({ length: 16 }, () => leidenFromCsrAsync({ ...csr, seed: 7 }));
    const results = await Promise.all(promises);
    const first = Array.from(results[0]!.membership);
    for (const r of results.slice(1)) {
      expect(Array.from(r.membership)).toEqual(first);
    }
  });

  it("soak: 100 short async calls in flight", async () => {
    // A bigger soak run. Catches drift / lock starvation that the smaller
    // tests miss. Kept short per call so the whole suite stays under a few
    // hundred milliseconds.
    const promises = [];
    for (let i = 0; i < 100; i++) {
      promises.push(leidenAsync({ ...TRIANGLES, seed: i }));
    }
    const results = await Promise.all(promises);
    expect(results).toHaveLength(100);
    for (const r of results) expect(r.membership.length).toBe(6);
  });
});
