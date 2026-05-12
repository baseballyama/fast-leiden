// Large-graph soak driver. Generates a stochastic block model graph of the
// requested size, runs `leiden` and `leidenAsync` on it, and prints a JSON
// summary of wall time + RSS so the CI workflow can attach it as an artifact.
//
// Usage:
//   pnpm soak --blocks=20 --per-block=2500 --p-in=0.02 --p-out=0.0001
//
// All flags are optional; defaults below produce a ~50 K node / 1-2 M edge
// graph that exercises the optimiser without taking forever on a GitHub
// runner.
/* oxlint-disable no-await-in-loop */
/* oxlint-disable no-console */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit, hrtime, memoryUsage, version } from "node:process";

import { leiden, leidenAsync } from "../dist/index.js";

interface Args {
  blocks: number;
  perBlock: number;
  pIn: number;
  pOut: number;
  seed: number;
  outPath: string;
}

const parseArgs = (raw: string[]): Args => {
  const defaults: Args = {
    blocks: 20,
    perBlock: 2_500,
    pIn: 0.02,
    pOut: 0.0001,
    seed: 1,
    outPath: "soak-summary.json",
  };
  const camel: Record<string, keyof Args> = {
    blocks: "blocks",
    "per-block": "perBlock",
    "p-in": "pIn",
    "p-out": "pOut",
    seed: "seed",
    out: "outPath",
  };
  for (const arg of raw) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) continue;
    const key = camel[m[1]!];
    if (key === undefined) continue;
    if (key === "outPath") defaults.outPath = m[2]!;
    else (defaults[key] as number) = Number(m[2]);
  }
  return defaults;
};

const generateSbm = (args: Args) => {
  // Same LCG as bench/basic.ts so soak runs are reproducible.
  let state = args.seed >>> 0 || 1;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const n = args.blocks * args.perBlock;
  const blockOf = (v: number) => Math.floor(v / args.perBlock);
  const sources: number[] = [];
  const targets: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = blockOf(i) === blockOf(j) ? args.pIn : args.pOut;
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

const timed = async <T>(fn: () => Promise<T> | T): Promise<{ result: T; ms: number }> => {
  const start = hrtime.bigint();
  const result = await fn();
  const ms = Number(hrtime.bigint() - start) / 1e6;
  return { result, ms };
};

const main = async () => {
  const args = parseArgs(argv.slice(2));
  console.log(
    `soak: blocks=${args.blocks} perBlock=${args.perBlock} ` +
      `pIn=${args.pIn} pOut=${args.pOut} seed=${args.seed}`,
  );

  const startBuild = hrtime.bigint();
  const graph = generateSbm(args);
  const buildMs = Number(hrtime.bigint() - startBuild) / 1e6;
  console.log(
    `soak: graph built in ${buildMs.toFixed(0)} ms — ` +
      `${graph.nodeCount} nodes, ${graph.sources.length} edges`,
  );

  const before = memoryUsage();

  const sync = await timed(() =>
    leiden({
      nodeCount: graph.nodeCount,
      sources: graph.sources,
      targets: graph.targets,
      seed: args.seed,
    }),
  );
  const afterSync = memoryUsage();
  console.log(`soak: sync run ${sync.ms.toFixed(0)} ms`);

  const async = await timed(() =>
    leidenAsync({
      nodeCount: graph.nodeCount,
      sources: graph.sources,
      targets: graph.targets,
      seed: args.seed,
    }),
  );
  const afterAsync = memoryUsage();
  console.log(`soak: async run ${async.ms.toFixed(0)} ms`);

  const distinct = new Set(Array.from(sync.result.membership)).size;

  const summary = {
    node: version,
    args,
    graph: {
      nodes: graph.nodeCount,
      edges: graph.sources.length,
      buildMs: Math.round(buildMs),
    },
    runs: {
      sync: { wallMs: Math.round(sync.ms) },
      async: { wallMs: Math.round(async.ms) },
    },
    rssBytes: {
      before: before.rss,
      afterSync: afterSync.rss,
      afterAsync: afterAsync.rss,
    },
    partition: {
      communities: distinct,
      finalQuality: sync.result.quality,
    },
  };

  writeFileSync(resolve(args.outPath), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`soak: summary written to ${args.outPath}`);
};

main().catch((err) => {
  console.error(err);
  exit(1);
});
