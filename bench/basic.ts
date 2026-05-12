// Benchmark fast-leiden against a Python `igraph + leidenalg` baseline on a
// synthetic stochastic block model graph. The Python comparison is best
// effort — if `python3 -c "import leidenalg, igraph"` fails the script just
// reports fast-leiden timings.
//
// Run with: `pnpm bench`
//
// We await sequentially inside the trial loop on purpose — measuring each
// run's wall time is the whole point — so the no-await-in-loop lint is
// suppressed for this file.
/* oxlint-disable no-await-in-loop */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Imported from the built dist so node --experimental-strip-types doesn't
// need to rewrite TypeScript import paths. `pnpm bench` runs the build
// first, so this is always up-to-date.
import { leiden, leidenAsync } from "../dist/index.js";

interface SbmGraph {
  nodeCount: number;
  blockCount: number;
  sources: Uint32Array;
  targets: Uint32Array;
}

const generateSbm = (
  blocks: number,
  perBlock: number,
  pIn: number,
  pOut: number,
  rngSeed: number,
): SbmGraph => {
  // Simple deterministic LCG so the benchmark is reproducible across runs
  // without pulling in a PRNG dependency.
  let state = rngSeed >>> 0 || 1;
  const rand = (): number => {
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
    blockCount: blocks,
    sources: new Uint32Array(sources),
    targets: new Uint32Array(targets),
  };
};

const formatMs = (ms: number) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(1)} ms`);

const timeIt = async <T>(fn: () => Promise<T> | T): Promise<[T, number]> => {
  const start = process.hrtime.bigint();
  const result = await fn();
  const ns = Number(process.hrtime.bigint() - start);
  return [result, ns / 1e6];
};

const recoveryRate = (membership: Uint32Array, blockCount: number, perBlock: number): number => {
  // Count, for each detected community, the most common true block.
  const tally = new Map<number, Map<number, number>>();
  for (let i = 0; i < membership.length; i++) {
    const comm = membership[i] ?? 0;
    const truth = Math.floor(i / perBlock);
    const row = tally.get(comm) ?? new Map<number, number>();
    row.set(truth, (row.get(truth) ?? 0) + 1);
    tally.set(comm, row);
  }
  let matched = 0;
  for (const row of tally.values()) {
    let best = 0;
    for (const c of row.values()) if (c > best) best = c;
    matched += best;
  }
  return matched / membership.length;
};

const PYTHON_DRIVER = `
import sys, json, time
try:
    import igraph as ig
    import leidenalg as la
except Exception as e:
    print(json.dumps({"available": False, "error": str(e)}))
    sys.exit(0)

with open(sys.argv[1]) as f:
    data = json.load(f)
n = data["nodeCount"]
edges = list(zip(data["sources"], data["targets"]))
g = ig.Graph(n=n, edges=edges, directed=False)

start = time.perf_counter()
part = la.find_partition(g, la.ModularityVertexPartition, seed=42)
elapsed = (time.perf_counter() - start) * 1000.0

print(json.dumps({
    "available": True,
    "elapsed_ms": elapsed,
    "communities": len(set(part.membership)),
    "quality": part.quality(),
}))
`;

// Prefer a project-local venv at bench/.venv if it exists (created by
// `python3 -m venv bench/.venv && bench/.venv/bin/pip install igraph leidenalg`).
// Falls back to the user's `python3` otherwise.
const resolvePython = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const venvPy = resolve(here, ".venv", "bin", "python");
  if (existsSync(venvPy)) return venvPy;
  return "python3";
};

interface PythonBaseline {
  available: boolean;
  error?: string;
  elapsedMs?: number;
  communities?: number;
  quality?: number;
}

const runPythonBaseline = (graph: SbmGraph): PythonBaseline => {
  const tmp = mkdtempSync(join(tmpdir(), "fast-leiden-bench-"));
  const graphPath = join(tmp, "graph.json");
  writeFileSync(
    graphPath,
    JSON.stringify({
      nodeCount: graph.nodeCount,
      sources: Array.from(graph.sources),
      targets: Array.from(graph.targets),
    }),
  );
  const py = spawnSync(resolvePython(), ["-c", PYTHON_DRIVER, graphPath], {
    encoding: "utf8",
  });
  if (py.error || py.status !== 0) {
    return { available: false, error: py.stderr || String(py.error) };
  }
  try {
    const raw = JSON.parse(py.stdout.trim()) as {
      available: boolean;
      error?: string;
      elapsed_ms?: number;
      communities?: number;
      quality?: number;
    };
    return {
      available: raw.available,
      error: raw.error,
      elapsedMs: raw.elapsed_ms,
      communities: raw.communities,
      quality: raw.quality,
    };
  } catch {
    return { available: false, error: `unparseable: ${py.stdout}` };
  }
};

const main = async (): Promise<void> => {
  const sizes = [
    { blocks: 5, perBlock: 100, pIn: 0.1, pOut: 0.005 },
    { blocks: 10, perBlock: 200, pIn: 0.05, pOut: 0.001 },
  ];

  // eslint-disable-next-line no-console
  console.log("fast-leiden bench — synthetic stochastic block model");
  // eslint-disable-next-line no-console
  console.log("");

  for (const cfg of sizes) {
    const g = generateSbm(cfg.blocks, cfg.perBlock, cfg.pIn, cfg.pOut, 12345);
    const edgeCount = g.sources.length;

    // eslint-disable-next-line no-console
    console.log(
      `[graph] n=${g.nodeCount}  edges=${edgeCount}  ` +
        `blocks=${cfg.blocks}  p_in=${cfg.pIn}  p_out=${cfg.pOut}`,
    );

    // Warm up.
    leiden({
      nodeCount: g.nodeCount,
      sources: g.sources,
      targets: g.targets,
      seed: 1,
    });

    const trials = 3;
    let syncTotal = 0;
    let asyncTotal = 0;
    let lastResult: ReturnType<typeof leiden> | undefined;
    for (let t = 0; t < trials; t++) {
      const [resSync, msSync] = await timeIt(() =>
        leiden({
          nodeCount: g.nodeCount,
          sources: g.sources,
          targets: g.targets,
          seed: t + 1,
        }),
      );
      const [, msAsync] = await timeIt(() =>
        leidenAsync({
          nodeCount: g.nodeCount,
          sources: g.sources,
          targets: g.targets,
          seed: t + 1,
        }),
      );
      syncTotal += msSync;
      asyncTotal += msAsync;
      lastResult = resSync;
    }
    const syncAvg = syncTotal / trials;
    const asyncAvg = asyncTotal / trials;

    const detectedCommunities =
      lastResult === undefined ? 0 : new Set(Array.from(lastResult.membership)).size;
    const recovery =
      lastResult === undefined
        ? 0
        : recoveryRate(lastResult.membership, g.blockCount, cfg.perBlock);

    // eslint-disable-next-line no-console
    console.log(`  fast-leiden sync:    avg ${formatMs(syncAvg)} over ${trials} runs`);
    // eslint-disable-next-line no-console
    console.log(`  fast-leiden async:   avg ${formatMs(asyncAvg)} over ${trials} runs`);
    // eslint-disable-next-line no-console
    console.log(
      `  communities found:   ${detectedCommunities} (truth: ${g.blockCount})  ` +
        `recovery: ${(recovery * 100).toFixed(1)}%`,
    );

    const py = runPythonBaseline(g);
    if (py.available) {
      // eslint-disable-next-line no-console
      console.log(
        `  python leidenalg:    ${formatMs(py.elapsedMs ?? 0)}  ` +
          `(${py.communities} communities, quality ${py.quality?.toFixed(4)})`,
      );
      if (py.elapsedMs && syncAvg > 0) {
        const speedup = py.elapsedMs / syncAvg;
        // eslint-disable-next-line no-console
        console.log(
          `  speedup vs python:   ${speedup.toFixed(2)}× (sync) ` +
            `${(py.elapsedMs / asyncAvg).toFixed(2)}× (async)`,
        );
      }
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `  python leidenalg:    not available — skipping comparison` +
          (py.error ? ` (${py.error.split("\n")[0]})` : ""),
      );
    }
    // eslint-disable-next-line no-console
    console.log("");
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
