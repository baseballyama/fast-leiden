// Lightweight performance gate for CI.
//
// Runs a small, deterministic stochastic-block-model graph through
// `leiden` and `leidenAsync` a handful of times and asserts that the
// median wall time stays under a threshold. The point is to catch
// catastrophic regressions on every PR — a 2x slowdown should show up
// here. The weekly soak (`bench/soak.ts`) covers the larger graphs.
//
// The thresholds below are conservative — set so a healthy CI runner
// finishes in roughly half the limit. If they ever turn flaky on a
// specific runner, widen the bound rather than removing the gate.
/* oxlint-disable no-await-in-loop */
/* oxlint-disable no-console */

import { hrtime, exit } from "node:process";

import { leiden, leidenAsync } from "../dist/index.js";

interface Graph {
  nodeCount: number;
  sources: Uint32Array;
  targets: Uint32Array;
}

const generateSbm = (
  blocks: number,
  perBlock: number,
  pIn: number,
  pOut: number,
  rngSeed: number,
): Graph => {
  // Same LCG as bench/basic.ts so this is byte-for-byte reproducible.
  let state = rngSeed >>> 0 || 1;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const n = blocks * perBlock;
  const sources: number[] = [];
  const targets: number[] = [];
  const blockOf = (v: number) => Math.floor(v / perBlock);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = blockOf(i) === blockOf(j) ? pIn : pOut;
      if (rand() < p) {
        sources.push(i);
        targets.push(j);
      }
    }
  }
  return {
    nodeCount: n,
    sources: new Uint32Array(sources),
    targets: new Uint32Array(targets),
  };
};

const median = (xs: number[]): number => {
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

const timed = async <T>(fn: () => Promise<T> | T): Promise<number> => {
  const start = hrtime.bigint();
  await fn();
  return Number(hrtime.bigint() - start) / 1e6;
};

// ~5K nodes / ~25K edges — large enough that the optimiser does real
// work, small enough that any CI runner finishes a single trial in
// well under a second.
const GRAPH = generateSbm(10, 500, 0.02, 0.0005, 1);
const TRIALS = 5;
// CI runners are slow and noisy; pick a budget that's >> the local
// number on a healthy laptop. Tight enough to catch a 5× regression
// but loose enough not to fight noise.
const SYNC_BUDGET_MS = Number.parseInt(process.env.PERF_GATE_SYNC_MS ?? "3000", 10);
const ASYNC_BUDGET_MS = Number.parseInt(process.env.PERF_GATE_ASYNC_MS ?? "3000", 10);

const main = async () => {
  console.log(
    `perf-gate: graph=${GRAPH.nodeCount} nodes / ${GRAPH.sources.length} edges, ` +
      `trials=${TRIALS}, sync<${SYNC_BUDGET_MS}ms async<${ASYNC_BUDGET_MS}ms`,
  );

  // Warm-up: first call includes JIT + addon init costs we don't want to
  // measure.
  leiden({
    nodeCount: GRAPH.nodeCount,
    sources: GRAPH.sources,
    targets: GRAPH.targets,
    seed: 42,
  });

  const syncTimes: number[] = [];
  for (let i = 0; i < TRIALS; i++) {
    syncTimes.push(
      await timed(() =>
        leiden({
          nodeCount: GRAPH.nodeCount,
          sources: GRAPH.sources,
          targets: GRAPH.targets,
          seed: 42 + i,
        }),
      ),
    );
  }
  const syncMedian = median(syncTimes);

  const asyncTimes: number[] = [];
  for (let i = 0; i < TRIALS; i++) {
    asyncTimes.push(
      await timed(() =>
        leidenAsync({
          nodeCount: GRAPH.nodeCount,
          sources: GRAPH.sources,
          targets: GRAPH.targets,
          seed: 42 + i,
        }),
      ),
    );
  }
  const asyncMedian = median(asyncTimes);

  console.log(
    `perf-gate: sync median=${syncMedian.toFixed(1)}ms (trials ${syncTimes.map((t) => t.toFixed(0)).join(",")})`,
  );
  console.log(
    `perf-gate: async median=${asyncMedian.toFixed(1)}ms (trials ${asyncTimes.map((t) => t.toFixed(0)).join(",")})`,
  );

  let failed = false;
  if (syncMedian > SYNC_BUDGET_MS) {
    console.error(
      `perf-gate FAIL: sync median ${syncMedian.toFixed(1)}ms exceeds budget ${SYNC_BUDGET_MS}ms`,
    );
    failed = true;
  }
  if (asyncMedian > ASYNC_BUDGET_MS) {
    console.error(
      `perf-gate FAIL: async median ${asyncMedian.toFixed(1)}ms exceeds budget ${ASYNC_BUDGET_MS}ms`,
    );
    failed = true;
  }
  if (failed) exit(1);
  console.log("perf-gate OK");
};

main().catch((err) => {
  console.error(err);
  exit(1);
});
