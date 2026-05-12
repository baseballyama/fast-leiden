import { native } from "./native.js";
import type { LeidenCsrInput, LeidenInput, LeidenResult } from "./types.js";

export type {
  LeidenCsrInput,
  LeidenInput,
  LeidenOptions,
  LeidenQualityFunction,
  LeidenResult,
} from "./types.js";

/** Native addon version string. Useful for smoke-testing the build. */
export const version = (): string => native.version();

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
 * noticeably stall the event loop.
 */
export const leidenAsync = (input: LeidenInput): Promise<LeidenResult> => {
  try {
    validateEdgeListInput(input);
  } catch (err) {
    return Promise.reject(err);
  }
  return native.leidenFromEdgeListAsync({
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

/** Asynchronous CSR variant. See {@link leidenAsync}. */
export const leidenFromCsrAsync = (input: LeidenCsrInput): Promise<LeidenResult> => {
  try {
    validateCsrInput(input);
  } catch (err) {
    return Promise.reject(err);
  }
  return native.leidenFromCsrAsync({
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
  const expectedEdgeCount = input.offsets[input.offsets.length - 1] ?? 0;
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
  }

  validateOptions(input);
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
};
