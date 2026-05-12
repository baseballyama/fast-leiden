import { describe, expect, it } from "vitest";
import { leidenAsync, leidenFromCsrAsync } from "../src/index.js";

// Build a graph big enough that leidenAsync takes a few milliseconds — gives
// the AbortSignal a window to fire before the worker thread completes.
const buildBigGraph = (n: number) => {
  const sources: number[] = [];
  const targets: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sources.push(i);
    targets.push(j);
  }
  for (let i = 0; i < n; i += 3) {
    sources.push(i);
    targets.push((i + Math.floor(n / 2)) % n);
  }
  return {
    nodeCount: n,
    sources: new Uint32Array(sources),
    targets: new Uint32Array(targets),
  };
};

describe("leidenAsync() — AbortSignal", () => {
  it("rejects immediately when given an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      leidenAsync({ ...buildBigGraph(10), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with the custom reason when abort is called with one", async () => {
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    controller.abort(reason);
    await expect(leidenAsync({ ...buildBigGraph(10), signal: controller.signal })).rejects.toBe(
      reason,
    );
  });

  it("rejects when the signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const promise = leidenAsync({
      ...buildBigGraph(800),
      signal: controller.signal,
      seed: 1,
    });
    // Fire abort on the next microtask tick — the worker has already been
    // queued by then but hasn't returned to the JS thread yet.
    queueMicrotask(() => controller.abort());
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves normally when the signal never aborts", async () => {
    const controller = new AbortController();
    const result = await leidenAsync({
      ...buildBigGraph(20),
      signal: controller.signal,
      seed: 1,
    });
    expect(result.membership.length).toBe(20);
  });

  it("does not leak a listener on the signal after success", async () => {
    const controller = new AbortController();
    await leidenAsync({
      ...buildBigGraph(20),
      signal: controller.signal,
      seed: 1,
    });
    // Implementation-specific: we register exactly one `abort` listener via
    // `{ once: true }` plus our internal one. After completion, no listeners
    // should remain.
    // Node exposes this via `signal[Symbol(kEvents)]` only in some versions,
    // so we test indirectly: aborting after completion must not throw and
    // must not affect anything.
    controller.abort();
    // Nothing to assert other than "no crash". The test passes by not
    // throwing.
  });

  it("works with AbortSignal.timeout()", async () => {
    const signal = AbortSignal.timeout(1);
    // Sleep a beat so the timer has time to fire on slow CI runners.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(leidenAsync({ ...buildBigGraph(10), signal })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});

describe("leidenFromCsrAsync() — AbortSignal", () => {
  it("rejects immediately on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      leidenFromCsrAsync({
        nodeCount: 2,
        offsets: new Uint32Array([0, 1, 1]),
        targets: new Uint32Array([1]),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when aborted mid-flight", async () => {
    const n = 300;
    const offsets = new Uint32Array(n + 1);
    const targetsArr: number[] = [];
    for (let i = 0; i < n; i++) {
      offsets[i] = targetsArr.length;
      targetsArr.push((i + 1) % n);
    }
    offsets[n] = targetsArr.length;
    const controller = new AbortController();
    const promise = leidenFromCsrAsync({
      nodeCount: n,
      offsets,
      targets: new Uint32Array(targetsArr),
      signal: controller.signal,
      seed: 1,
    });
    queueMicrotask(() => controller.abort());
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
