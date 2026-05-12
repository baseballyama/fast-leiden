import { createRequire } from "node:module";
import { native } from "./native.js";
import type { LeidenCsrInput, LeidenInput, LeidenResult } from "./types.js";

export type {
  LeidenCsrInput,
  LeidenInput,
  LeidenOptions,
  LeidenQualityFunction,
  LeidenResult,
} from "./types.js";

// Read package.json at runtime instead of hard-coding the version in the
// source. The native side reads the same value via a generated header
// (scripts/write-version-header.mjs), so both layers share package.json as the
// single source of truth.
const pkg = createRequire(__filename)("../package.json") as { version: string };

/** Package version. Matches `package.json` exactly. */
export const version = (): string => pkg.version;

/**
 * Run Leiden community detection on an edge-list graph.
 *
 * This is the user-friendly entry point. For very large graphs, prefer
 * {@link leidenFromCsr} — it avoids the edge-list -> CSR conversion that
 * happens internally here.
 */
export const leiden = (input: LeidenInput): LeidenResult => {
  validateEdgeListInput(input);
  return native.leidenFromEdgeList({
    nodeCount: input.nodeCount,
    sources: input.sources,
    targets: input.targets,
    weights: input.weights,
    qualityFunction: input.qualityFunction,
    resolution: input.resolution,
    maxIterations: input.maxIterations,
    seed: input.seed,
    directed: input.directed,
  });
};

/**
 * Run Leiden community detection on a CSR-encoded graph. Recommended for
 * large graphs where you already have CSR arrays on hand.
 */
export const leidenFromCsr = (input: LeidenCsrInput): LeidenResult => {
  validateCsrInput(input);
  return native.leidenFromCsr({
    nodeCount: input.nodeCount,
    offsets: input.offsets,
    targets: input.targets,
    weights: input.weights,
    qualityFunction: input.qualityFunction,
    resolution: input.resolution,
    maxIterations: input.maxIterations,
    seed: input.seed,
    directed: input.directed,
  });
};

/**
 * Asynchronous edge-list variant. The Leiden optimisation runs on a libuv
 * worker thread; the returned Promise resolves with the same shape as
 * {@link leiden}.
 *
 * Prefer this for graphs large enough that the synchronous call would
 * noticeably stall the event loop. Pass `signal` to cancel an in-flight
 * run — the Promise rejects with `signal.reason`. Note that the worker
 * thread may continue running until completion; we do not yet propagate
 * the cancel into libleidenalg.
 */
export const leidenAsync = (input: LeidenInput): Promise<LeidenResult> => {
  try {
    validateEdgeListInput(input);
  } catch (err) {
    return Promise.reject(err);
  }
  return runWithSignal(input.signal, () =>
    native.leidenFromEdgeListAsync({
      nodeCount: input.nodeCount,
      sources: input.sources,
      targets: input.targets,
      weights: input.weights,
      qualityFunction: input.qualityFunction,
      resolution: input.resolution,
      maxIterations: input.maxIterations,
      seed: input.seed,
      directed: input.directed,
    }),
  );
};

/** Asynchronous CSR variant. See {@link leidenAsync}. */
export const leidenFromCsrAsync = (input: LeidenCsrInput): Promise<LeidenResult> => {
  try {
    validateCsrInput(input);
  } catch (err) {
    return Promise.reject(err);
  }
  return runWithSignal(input.signal, () =>
    native.leidenFromCsrAsync({
      nodeCount: input.nodeCount,
      offsets: input.offsets,
      targets: input.targets,
      weights: input.weights,
      qualityFunction: input.qualityFunction,
      resolution: input.resolution,
      maxIterations: input.maxIterations,
      seed: input.seed,
      directed: input.directed,
    }),
  );
};

// Wrap an async native call with AbortSignal-style cancellation. The native
// worker is not (yet) cooperatively cancellable, so on abort we fire-and-
// forget: the Promise rejects immediately with `signal.reason`, and any
// later resolution from the worker is dropped. This is documented in
// LeidenOptions["signal"] and in README "Known limitations".
const runWithSignal = (
  signal: AbortSignal | undefined,
  start: () => Promise<LeidenResult>,
): Promise<LeidenResult> => {
  if (signal === undefined) return start();
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<LeidenResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    start().then(
      (result) => settle(() => resolve(result)),
      (err) => settle(() => reject(err)),
    );
  });
};

// --- Validation -----------------------------------------------------------
//
// Validation happens at the JS/C++ boundary. The TS side rejects with clear
// errors so consumers get actionable feedback before any data crosses into
// native code; the C++ side has its own validation as a segfault safety net.

const validateNodeCount = (nodeCount: number): void => {
  if (!Number.isInteger(nodeCount) || nodeCount < 0) {
    throw new TypeError(`nodeCount must be a non-negative integer, got ${nodeCount}`);
  }
  if (nodeCount > 0xffffffff) {
    throw new RangeError(`nodeCount must fit in a 32-bit unsigned integer, got ${nodeCount}`);
  }
};

const validateEdgeListInput = (input: LeidenInput): void => {
  validateNodeCount(input.nodeCount);

  if (!(input.sources instanceof Uint32Array)) {
    throw new TypeError("sources must be a Uint32Array");
  }
  if (!(input.targets instanceof Uint32Array)) {
    throw new TypeError("targets must be a Uint32Array");
  }
  if (input.sources.length !== input.targets.length) {
    throw new RangeError(
      `sources and targets must have the same length ` +
        `(${input.sources.length} vs ${input.targets.length})`,
    );
  }
  if (input.weights !== undefined) {
    if (!(input.weights instanceof Float64Array)) {
      throw new TypeError("weights must be a Float64Array when provided");
    }
    if (input.weights.length !== input.sources.length) {
      throw new RangeError(
        `weights length must match edge count ` +
          `(${input.weights.length} vs ${input.sources.length})`,
      );
    }
    validateWeights(input.weights);
  }

  validateOptions(input);
};

const validateCsrInput = (input: LeidenCsrInput): void => {
  validateNodeCount(input.nodeCount);

  if (!(input.offsets instanceof Uint32Array)) {
    throw new TypeError("offsets must be a Uint32Array");
  }
  if (input.offsets.length !== input.nodeCount + 1) {
    throw new RangeError(
      `offsets length must be nodeCount + 1 ` +
        `(${input.offsets.length} vs ${input.nodeCount + 1})`,
    );
  }
  if (!(input.targets instanceof Uint32Array)) {
    throw new TypeError("targets must be a Uint32Array");
  }
  // offsets[0] must be 0 and the array must be monotonically non-decreasing.
  // Without these checks a malformed CSR can drive the native side into an
  // out-of-bounds write (see ReadCsrJob in native/binding.cc).
  if (input.offsets[0] !== 0) {
    throw new RangeError(`offsets[0] must be 0, got ${input.offsets[0]}`);
  }
  const expectedEdgeCount = input.offsets[input.offsets.length - 1] ?? 0;
  for (let i = 1; i < input.offsets.length; i++) {
    const prev = input.offsets[i - 1]!;
    const cur = input.offsets[i]!;
    if (cur < prev) {
      throw new RangeError(
        `offsets must be non-decreasing (offsets[${i - 1}]=${prev} > offsets[${i}]=${cur})`,
      );
    }
    if (cur > expectedEdgeCount) {
      throw new RangeError(`offsets[${i}]=${cur} exceeds offsets[-1]=${expectedEdgeCount}`);
    }
  }
  if (input.targets.length !== expectedEdgeCount) {
    throw new RangeError(
      `targets length must match offsets[-1] ` +
        `(${input.targets.length} vs ${expectedEdgeCount})`,
    );
  }
  if (input.weights !== undefined) {
    if (!(input.weights instanceof Float64Array)) {
      throw new TypeError("weights must be a Float64Array when provided");
    }
    if (input.weights.length !== input.targets.length) {
      throw new RangeError(
        `weights length must match edge count ` +
          `(${input.weights.length} vs ${input.targets.length})`,
      );
    }
    validateWeights(input.weights);
  }

  validateOptions(input);
};

// NaN / Infinity in weights would propagate through libleidenalg and surface
// as a `quality: NaN` result, silently corrupting the partition score. Reject
// at the boundary so the failure is visible.
//
// Negative weights are also rejected: modularity is defined over the
// non-negative reals, and libleidenalg's CPM partition treats edge weights as
// a measure of attraction. Allowing negatives lets the algorithm "succeed"
// while returning a meaningless partition.
const validateWeights = (weights: Float64Array): void => {
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    if (!Number.isFinite(w)) {
      throw new RangeError(`weights[${i}] must be finite, got ${w}`);
    }
    if (w < 0) {
      throw new RangeError(`weights[${i}] must be non-negative, got ${w}`);
    }
  }
};

const validateOptions = (input: LeidenInput | LeidenCsrInput): void => {
  if (
    input.resolution !== undefined &&
    !(Number.isFinite(input.resolution) && input.resolution >= 0)
  ) {
    throw new RangeError(
      `resolution must be a non-negative finite number, got ${input.resolution}`,
    );
  }
  if (
    input.maxIterations !== undefined &&
    (!Number.isInteger(input.maxIterations) || input.maxIterations < 1)
  ) {
    throw new RangeError(`maxIterations must be a positive integer, got ${input.maxIterations}`);
  }
  if (
    input.qualityFunction !== undefined &&
    input.qualityFunction !== "modularity" &&
    input.qualityFunction !== "cpm"
  ) {
    throw new TypeError(
      `qualityFunction must be "modularity" or "cpm", got ${String(input.qualityFunction)}`,
    );
  }
  if (input.seed !== undefined) {
    // The native side calls Uint32Value(), which silently converts -1, 1.5,
    // NaN, and Infinity into something the caller didn't ask for. Reject those
    // here so determinism contracts hold.
    if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff) {
      throw new RangeError(`seed must be an integer in [0, 2^32), got ${String(input.seed)}`);
    }
  }
};
