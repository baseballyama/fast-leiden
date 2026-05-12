// Public type definitions for fast-leiden.
//
// The library is TypedArray-first: edge lists and CSR arrays are passed as
// `Uint32Array` / `Float64Array` so that the native side can read them
// without copying. Convenience wrappers around plain JS arrays are
// intentionally out of scope — see CLAUDE.md ("One way to do one thing").

/**
 * Quality function used by the Leiden algorithm.
 *
 * - `modularity`: classical Newman–Girvan modularity. Resolution-limited on
 *   large, hierarchical graphs.
 * - `cpm`: Constant Potts Model. Recommended when you want to control
 *   community granularity via the `resolution` parameter.
 */
export type LeidenQualityFunction = "modularity" | "cpm";

export interface LeidenOptions {
  /** Resolution parameter. Higher values produce more, smaller communities. */
  resolution?: number;
  /** Quality function. Defaults to `"modularity"`. */
  qualityFunction?: LeidenQualityFunction;
  /** Maximum iterations of the outer Leiden loop. */
  maxIterations?: number;
  /**
   * Random seed for the algorithm. Setting this makes runs deterministic for
   * the same input.
   */
  seed?: number;
  /** Treat the graph as directed. Defaults to `false`. */
  directed?: boolean;
}

/** Edge-list input. */
export interface LeidenInput extends LeidenOptions {
  /** Total number of nodes. Node ids are `[0, nodeCount)`. */
  nodeCount: number;
  /** Source endpoint per edge. */
  sources: Uint32Array;
  /** Target endpoint per edge. `targets.length` must equal `sources.length`. */
  targets: Uint32Array;
  /** Optional edge weights. Same length as `sources` / `targets`. */
  weights?: Float64Array;
}

/** CSR (compressed sparse row) input — preferred for large graphs. */
export interface LeidenCsrInput extends LeidenOptions {
  /** Total number of nodes. */
  nodeCount: number;
  /**
   * Offsets into `targets` / `weights` per node. Length `nodeCount + 1`.
   * Edges for node `i` are at `targets[offsets[i] : offsets[i + 1]]`.
   */
  offsets: Uint32Array;
  /** Target endpoint per edge, ordered by source node. */
  targets: Uint32Array;
  /** Optional edge weights, aligned with `targets`. */
  weights?: Float64Array;
}

export interface LeidenResult {
  /** Community id per node. `membership[i]` is the community of node `i`. */
  membership: Uint32Array;
  /** Final quality score under the selected quality function. */
  quality: number;
  /** Number of outer-loop iterations the algorithm ran. */
  iterations: number;
}
