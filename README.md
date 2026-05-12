# fast-leiden

> **Fast Leiden community detection for Node.js, powered by native igraph/libleidenalg bindings.**

`fast-leiden` runs the Leiden community-detection algorithm directly inside a
Node.js process, without spawning a Python worker. It wraps the C/C++ reference
implementations of [`igraph`](https://igraph.org/) and
[`libleidenalg`](https://github.com/vtraag/libleidenalg) (the C++ core extracted
from [`leidenalg`](https://github.com/vtraag/leidenalg)) via N-API and exposes a
TypeScript-first API built around `Uint32Array` / `Float64Array` so the V8 ↔ C++
hand-off stays compact and predictable (one bulk copy per array — no per-edge
JS allocations, no JSON / IPC serialization).

## Status

**1.0 — stable public API.** Working end-to-end on macOS, Linux, and
Windows in CI (Node 22 / 24 / 26). Shipped as an **ES module** with
`"type": "module"`. Modularity and CPM quality functions are supported.
Both edge-list and CSR input paths are implemented. Prebuilt binaries
for every Tier 1 platform; async runs support `AbortSignal` (soft
cancel — see [Async semantics](#async-semantics)). Every call into the
native side is serialized by a process-global mutex (igraph upstream
is not thread-safe), so `Promise.all` of async calls completes
correctly but does not run in parallel; for parallel throughput, see
[Recommended deploy patterns](#recommended-deploy-patterns). The
public API surface is locked under SemVer — see
[Versioning and breaking-change policy](#versioning-and-breaking-change-policy).
To report a security issue, see [SECURITY.md](./SECURITY.md).

## Goals

- Run Leiden from a Node.js server without a Python sidecar.
- Provide an ergonomic TypeScript API for large graphs.
- Use TypedArray (`Uint32Array` / `Float64Array`) inputs and outputs so the V8
  ↔ C++ hand-off is a single bulk memcpy per array, not a per-edge JS-object
  walk. (The native side still keeps an owned copy so the algorithm can run on
  a worker thread safely; this is a trade-off, not true zero-copy.)
- Keep the C/C++ reference implementations available as git submodules under
  `vendor/` so contributors can inspect and step through the source.

## Non-goals

- Re-implementing Leiden in pure JavaScript. The whole point is to reuse the
  battle-tested C/C++ code.
- Exposing every igraph capability. The public API stays focused on Leiden and
  the graph constructs Leiden needs.

## API

```ts
import { leiden, leidenFromCsr } from "fast-leiden";

// Edge-list input
const result = leiden({
  nodeCount,
  sources, // Uint32Array, length = edgeCount
  targets, // Uint32Array, length = edgeCount
  weights, // optional Float64Array, length = edgeCount
  qualityFunction: "modularity", // or "cpm"
  resolution: 1.0, // used by CPM
  maxIterations: 10,
  seed: 42, // optional — makes runs deterministic
  directed: false,
});

// CSR input — preferred when you already hold CSR arrays. Skips the
// edge-list → CSR conversion that leiden() does internally.
const resultCsr = leidenFromCsr({
  nodeCount,
  offsets, // Uint32Array, length = nodeCount + 1
  targets, // Uint32Array, length = edgeCount
  weights, // optional Float64Array
});

// result.membership : Uint32Array of community id per node
// result.quality    : final quality score under the chosen quality function
// result.iterations : number of outer-loop iterations the algorithm ran
```

For graphs large enough that the synchronous call would noticeably stall the
event loop, use the async variants — the Leiden optimisation runs on a libuv
worker thread:

```ts
import { leidenAsync, leidenFromCsrAsync } from "fast-leiden";

const result = await leidenAsync({ nodeCount, sources, targets, seed: 42 });
const resultCsr = await leidenFromCsrAsync({ nodeCount, offsets, targets });
```

See [`src/types.ts`](./src/types.ts) for the full type definitions.

## API contract

Reading this section before you ship is recommended — it captures the
behaviour the public API is committed to, including the cases where Leiden's
semantics differ from a naïve graph-algorithm intuition.

### Input shape

- **Node ids are dense, `[0, nodeCount)`.** Sparse / arbitrary ids are not
  supported; remap to dense ids before calling.
- **TypedArrays must be exactly the documented element type.** `sources`,
  `targets`, `offsets` are `Uint32Array` (not `Int32Array`, `Uint8Array`, or
  any other view). `weights` is `Float64Array` (not `Float32Array`). The
  native side checks the element type and throws `TypeError` on mismatch — a
  `Uint8Array` cast to `uint32_t*` would alias the buffer at the wrong stride.
- **`weights` are finite and non-negative.** `NaN`, `±Infinity`, and negative
  values are rejected with `RangeError`. Modularity is defined over the
  non-negative reals, and `libleidenalg`'s CPM partition treats weights as a
  measure of attraction.
- **`weights[i] === 0` is accepted** and treated as "edge present but
  contributes nothing to the quality score" — equivalent to omitting the edge
  for modularity.
- **Self-loops and multi-edges are accepted.** Leiden in `libleidenalg`
  handles both. They affect the quality score but never crash the algorithm.
- **Isolated nodes are accepted.** A node with no incident edges ends up in
  its own community (modularity is maximised that way).
- **CSR `offsets` must be monotonically non-decreasing, start at 0, and end
  at the number of edges.** Bad CSR is the most dangerous shape for a native
  addon — the validator on both sides rejects it before any pointer arithmetic.

### Output shape

- **`membership[i]` is the community id of node `i`** in `[0, nodeCount)`.
  Community ids are **not stable across runs, seeds, or library versions** —
  only the _partition_ (the equivalence classes) is meaningful. If you need
  a stable label, derive your own canonical naming from `membership`.
- **`quality`** is the final score under the selected quality function. The
  scale and units differ between `modularity` and `cpm`; do not compare
  values across quality functions.
- **`iterations`** is the number of outer-loop iterations actually run, up
  to `maxIterations`. The algorithm stops early when no further improvement
  is found.

### Options

- **`qualityFunction`** defaults to `"modularity"`. Only `"cpm"` reads the
  `resolution` parameter; with `qualityFunction: "modularity"` the value is
  silently ignored, by design (this matches `leidenalg`).
- **`resolution`** must be a non-negative finite number. Higher values
  produce more, smaller communities under CPM.
- **`maxIterations`** must be a positive integer. The outer Leiden loop runs
  at most this many times; the algorithm stops early when no further
  improvement is found.
- **`seed`** must be an integer in `[0, 2^32)`. Setting it pins the RNG and
  makes a run deterministic given the same input _and_ the same
  `libleidenalg` version. Across submodule bumps, the partition may shift.
- **`directed`** defaults to `false`. Setting it to `true` switches the
  underlying igraph construction; quality scores under directed and
  undirected modes are not comparable.

### Async semantics

The async variants (`leidenAsync`, `leidenFromCsrAsync`) run the optimiser on
a libuv worker thread, but **input validation and the TypedArray-to-vector
copy happen synchronously on the JS thread before the worker is queued.** For
multi-million-edge graphs the copy itself is non-trivial — measure on your
data shape if event-loop stalls matter.

Async calls accept an `AbortSignal` via the `signal` option:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000); // 30s deadline

try {
  const result = await leidenAsync({
    nodeCount,
    sources,
    targets,
    signal: controller.signal,
  });
} catch (err) {
  if ((err as Error).name === "AbortError") {
    // …respond to the deadline
  } else throw err;
}

// AbortSignal.timeout() works too:
await leidenAsync({ nodeCount, sources, targets, signal: AbortSignal.timeout(5_000) });
```

> ⚠️ **`signal` is a soft cancel, not a hard cancel.** When the signal
> aborts, the returned Promise rejects **immediately** with `signal.reason`,
> but **the native worker thread keeps running until it finishes**. CPU and
> memory are not released early; only the JS-side handle is. The cost is
> bounded by the size of the graph you queued, but on a multi-million-edge
> graph that can be tens of seconds of wasted compute after abort.
>
> If you need a real CPU-and-memory deadline (not just a "your code
> unblocks" deadline), run the call inside a `worker_threads` worker or a
> child process that you can `terminate()` / `kill()`. That is the only
> mechanism today that releases the native thread immediately. Native
> cooperative cancellation (propagating into `libleidenalg` via igraph's
> interruption handler) is on the roadmap; track it in the open issues.

Async calls into the native side are **serialized by a process-global
mutex**. `igraph`'s error-handling layer is not thread-safe (see
[`igraph_error.h`](./vendor/igraph/include/igraph_error.h)), so we
sequence every Leiden call — sync or async, from any thread — behind the
same lock. Many parallel `leidenAsync` callers therefore run one-at-a-
time on the worker pool; the benefit you get from `*Async` is still
"don't block the event loop", not "use 4 CPU cores". For true parallel
throughput use multiple `worker_threads` (each with its own loaded addon
copy) or multiple processes.

## Memory footprint

Rough rule of thumb per call, in addition to the input arrays you allocated:

- One full copy of `sources`, `targets`, and (if provided) `weights` inside
  the native job, so the worker thread owns its data: roughly `4 + 4 + 8`
  bytes per edge = **16 B/edge** (12 B/edge without weights).
- The internal `igraph_t` and `libleidenalg` partition state. Empirically
  this is on the order of **40–80 B/edge** plus **~24 B/node** for the
  partition / membership vectors.
- The returned `membership` `Uint32Array`: 4 B/node.

For 10 M edges + 1 M nodes that's roughly 400–800 MB of _native_ memory in
addition to the input arrays. Budget accordingly on small VMs or serverless
runtimes.

## Recommended usage

- **`leiden` / `leidenFromCsr` (sync)**: development, small graphs (rule of
  thumb: under ~50 K edges), CLIs, batch jobs that don't share the event
  loop with anything else.
- **`leidenAsync` / `leidenFromCsrAsync`**: long-lived servers, anything
  serving concurrent HTTP / RPC traffic, graphs large enough that the input
  copy _plus_ the optimiser would stall the loop for more than a few
  milliseconds.
- **Always prefer CSR for large graphs** if you already have CSR arrays. The
  edge-list path runs an extra conversion step internally.
- **For parallel throughput, span processes — not just promises.** Async
  calls are serialized inside the native addon (see
  [Async semantics](#async-semantics)). One `leidenAsync` keeps the event
  loop responsive; a hundred `leidenAsync` calls run one-at-a-time on the
  worker pool. Use multiple `worker_threads` (each loads its own addon
  copy) or multiple processes if you want N concurrent runs.
- **Need a hard deadline?** Run the call inside a `worker_threads` worker
  or child process you can `terminate()` / `kill()`. `AbortSignal` only
  unblocks your JS code; it does not release the native CPU/memory until
  the run finishes.

## Recommended deploy patterns

The native addon has two unavoidable constraints that callers must work
around when running it in production:

1. `AbortSignal` is a **soft cancel** — it unblocks the awaiting JS
   code but leaves the native worker thread running.
2. Every call into the native side is **serialized by a process-global
   mutex** because `igraph`'s error layer is not thread-safe.

If your workload hits either constraint, pick the deploy pattern below
that matches what you actually need.

### Pattern A — single in-process worker

For an event-loop-friendly server that handles **occasional** Leiden
calls one at a time, just call `leidenAsync` directly. Use
`AbortSignal.timeout()` to bound the wall-clock latency on your side;
accept that the native run may still finish on its own. This is the
right pattern when Leiden is a low-frequency operation on graphs small
enough that "wasted CPU after abort" is acceptable.

```ts
import { leidenAsync } from "fast-leiden";

await leidenAsync({
  nodeCount,
  sources,
  targets,
  signal: AbortSignal.timeout(5_000),
});
```

### Pattern B — N `worker_threads` for parallel throughput

If you need N concurrent Leiden runs from one process, spawn N
`worker_threads`. Each worker loads its own copy of the addon, so the
process-global mutex is **per-worker** and the runs proceed in
parallel. The worker pool below is the minimum viable version.

```ts
// main.ts
import { Worker } from "node:worker_threads";

type Job = {
  nodeCount: number;
  sources: Uint32Array;
  targets: Uint32Array;
  seed?: number;
};

const runOnWorker = (job: Job) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./leiden-worker.js", import.meta.url));
    worker.once("message", resolve);
    worker.once("error", reject);
    // Move the TypedArrays so we don't pay a structured-clone copy.
    worker.postMessage(job, [job.sources.buffer, job.targets.buffer]);
  });

const results = await Promise.all([runOnWorker(j1), runOnWorker(j2), runOnWorker(j3)]);
```

```ts
// leiden-worker.ts
import { parentPort } from "node:worker_threads";
import { leidenAsync } from "fast-leiden";

parentPort?.on("message", async (job) => {
  const result = await leidenAsync(job);
  parentPort?.postMessage(result, [result.membership.buffer]);
});
```

### Pattern C — `worker_threads` with hard deadline

When you need a real CPU-and-memory deadline (not just "your code
unblocks"), wrap the call in a worker you can `terminate()`. The
`terminate()` call frees the native thread's CPU and memory; this is
the only mechanism today that releases the worker immediately on
abort. Same `leiden-worker.ts` as above.

```ts
import { Worker } from "node:worker_threads";

const runWithHardDeadline = (job, deadlineMs) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./leiden-worker.js", import.meta.url));
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("hard deadline exceeded"));
    }, deadlineMs);
    worker.once("message", (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.postMessage(job, [job.sources.buffer, job.targets.buffer]);
  });
```

### Pattern D — child process pool for high-throughput services

For services that need to push tens of concurrent Leiden runs per
second, child processes scale further than `worker_threads` (more
isolation from V8's heap, easier OS-level resource limits). Use
[`piscina`](https://github.com/piscinajs/piscina) or write a thin
fork/IPC pool around `leiden-worker.ts`. Same caveats: each child
loads its own addon copy, so the mutex is per-child.

### Sizing rules of thumb

- **One worker per logical CPU core.** Leiden is CPU-bound. Going
  above that thrashes the OS scheduler without speeding anything up.
- **Pre-allocate the pool.** Spawning a `worker_threads` worker
  costs ~30 ms (V8 init + addon load). For latency-sensitive
  endpoints, warm the pool at boot.
- **Bound input size at the edge.** The library does not stream;
  the whole graph must fit in memory and the optimiser is `O(E · k)`
  where `k` is the number of outer iterations. A 100 M edge graph
  will OOM a typical 4 GB serverless function.
- **Set `signal: AbortSignal.timeout(...)` even with Pattern B.**
  Soft-cancel still bounds how long your JS code waits even when
  it can't bound the worker's CPU.

## Install

```bash
npm install fast-leiden
# or
pnpm add fast-leiden
```

On the [Tier 1 platforms](#supported-platforms) (`linux-x64` glibc/musl,
`linux-arm64` glibc/musl, `darwin-arm64`, `win32-x64`) install is a binary
drop — no CMake, no C++ toolchain, no Python. `darwin-x64` (Intel Mac) is
**Tier 2** and falls through to the source build (CMake + node-gyp + Python).

### Install model

The npm tarball ships **prebuilt binaries via [`prebuildify`](https://github.com/prebuild/prebuildify)**
for the platforms in our release matrix:

| Platform        | libc  | Status                                     |
| --------------- | ----- | ------------------------------------------ |
| `linux-x64`     | glibc | ✅ prebuilt                                |
| `linux-x64`     | musl  | ✅ prebuilt (Alpine / distroless musl)     |
| `linux-arm64`   | glibc | ✅ prebuilt (AWS Graviton, ARM servers)    |
| `linux-arm64`   | musl  | ✅ prebuilt (Alpine on ARM)                |
| `darwin-arm64`  | —     | ✅ prebuilt (Apple Silicon)                |
| `darwin-x64`    | —     | ⚠️ source build only (Intel Mac, Tier 2)   |
| `win32-x64`     | —     | ✅ prebuilt                                |
| `win32-arm64`,… |       | ❌ not yet — file an issue if you need one |

`scripts/install.mjs` runs as the `install` lifecycle script. It looks for a
prebuild matching the current `<platform>-<arch>` via
[`node-gyp-build`](https://github.com/prebuild/node-gyp-build); if one exists,
no toolchain is required. If no prebuild matches (or you're installing from
a git checkout), it falls back to the **source build**: CMake builds the
vendored `igraph` and `libleidenalg` static libs, then `node-gyp rebuild`
compiles the addon against them. The source build needs CMake, a C++17
toolchain, and Python 3, and takes several minutes the first time.

The tarball still ships the vendored sources so the source-build fallback
works on any platform that has the toolchain. If you're packaging into a
container where every byte matters, you can strip `vendor/` after install
once the addon is built.

**Release-side guarantee.** The release workflow
([`.github/workflows/release.yml`](./.github/workflows/release.yml)) runs
the prebuild matrix as a hard dependency of the publish job and verifies
that every platform listed above produced a `*.node` artifact before it
calls `changeset publish`. A missing platform aborts the publish — we
never want to ship a tarball with a hole in the matrix that silently
falls through to source build on consumer machines.

For local development:

```bash
git clone --recursive https://github.com/baseballyama/fast-leiden.git
cd fast-leiden
pnpm install
pnpm build          # builds igraph + libleidenalg (CMake), then the addon, then TS
pnpm test
```

If you already cloned without `--recursive`, fetch the submodules:

```bash
git submodule update --init --recursive
```

The first build takes several minutes because `vendor/igraph` and
`vendor/libleidenalg` are compiled from source via CMake. Subsequent builds
reuse the install tree under `vendor/build-deps/install/`. The build script
writes a `.build-sentinel.json` next to the libs capturing the host platform,
arch, Node major, and macOS deployment target; if any of those change between
runs, the install tree is wiped and the deps are rebuilt automatically.

### Reproducible dev environment (Nix)

If you have [Nix](https://nixos.org/download.html) with flakes enabled, all
build dependencies (Node 24, CMake, Python + `igraph` + `leidenalg`) are
pinned in `flake.nix`:

```bash
nix develop                     # one-shot shell
# or, with direnv:
direnv allow                    # auto-loads on cd
```

Inside the shell, `pnpm install && pnpm build && pnpm test` works without any
further setup, and `pnpm bench` finds Python's leidenalg out of the box.

## Build requirements (without Nix)

- Node.js >= 22 (24 LTS recommended)
- A C++17 toolchain (Xcode CLT on macOS, `build-essential` on Linux, MSVC on
  Windows)
- CMake >= 3.23 (the requirement comes from `libleidenalg`)
- Python 3 (for `node-gyp`)

## Supported platforms

### Support tiers

We commit to three levels of support. Pick the tier that matches your
deployment target before adopting:

**Tier 1 — fully supported.** Prebuilt binaries shipped on every release,
exercised by the full CI matrix (source build + sanitizers + tarball
install) on every commit. A regression on any Tier 1 target blocks a
release.

- `linux-x64` (glibc and musl)
- `linux-arm64` (glibc and musl)
- `darwin-arm64` (Apple Silicon)
- `win32-x64`
- Node.js 22 / 24 / 26 (`engines.node` is `>=22`)

**Tier 2 — best-effort, source build.** No prebuilt binary; the install
hook falls through to building from source via CMake + node-gyp +
Python 3. We accept bug reports and will land fixes, but we don't gate
releases on it. If a Tier 2 target stops building, we ship anyway and
fix it in a follow-up patch release.

- `darwin-x64` (Intel Mac). GitHub retired the `macos-13` runner, the
  modern free macOS runner is arm64-only, and we don't currently
  cross-compile or run a paid Intel runner. The source build still
  works on an Intel Mac with Xcode CLT + CMake + Python 3; let us
  know if a prebuild path matters for you and we'll prioritise it.
- Node.js 20 and older 22.x point releases (`engines.node` is advisory;
  the addon is N-API so it _usually_ loads, but we don't run CI on it).
- Linux distributions outside the libc set above (uClibc, etc.).
- Linux on architectures other than x64 / arm64 (riscv64, ppc64le, …).

**Not supported.** No prebuild, no CI, and we do not accept bug reports
beyond "would be nice to add" feature requests. If you ship on one of
these and need help, open an issue describing the runner and toolchain
you use; we'd rather add the target than tell you to ship without a
prebuild.

- `win32-arm64`. GitHub Actions doesn't ship a free ARM Windows runner;
  this would need a self-hosted runner or a cross-compile path.
- FreeBSD and other BSDs.
- Cross-compilation targets (e.g., building `darwin-x64` from
  `linux-arm64`, or `linux-riscv64` from anywhere).

### CI matrices

Two matrices live next to each other in CI; both have to be green for a
release to ship.

**Source build + test matrix**
([`ci.yml`](./.github/workflows/ci.yml)) — exercises every commit against
the source build, the public API, and the sanitizers:

| OS             | Node 22 | Node 24 | Node 26 | Notes                                  |
| -------------- | ------- | ------- | ------- | -------------------------------------- |
| ubuntu-latest  | ✅      | ✅      | ✅      | glibc; ASan + UBSan job runs alongside |
| macos-latest   | ✅      | ✅      | ✅      | arm64; deployment target 11.0          |
| windows-latest | ✅      | ✅      | ✅      | x64; MSVC                              |

A `pack-install` job in the same workflow also packs the tarball, installs
it into a fresh project, and runs a smoke test on `ubuntu-latest` and
`macos-latest` × Node 22 / 24.

**Prebuild + publish matrix**
([`release.yml`](./.github/workflows/release.yml)) — runs the prebuild
matrix on every push to `main` once the Version Packages PR merges, and
refuses to publish unless every artifact produced a `*.node`:

| Artifact            | Runner             | Container        | libc tag |
| ------------------- | ------------------ | ---------------- | -------- |
| `linux-x64-glibc`   | `ubuntu-latest`    | —                | `glibc`  |
| `linux-x64-musl`    | `ubuntu-latest`    | `node:22-alpine` | `musl`   |
| `linux-arm64-glibc` | `ubuntu-24.04-arm` | —                | `glibc`  |
| `linux-arm64-musl`  | `ubuntu-24.04-arm` | `node:22-alpine` | `musl`   |
| `darwin-arm64`      | `macos-latest`     | —                | —        |
| `win32-x64`         | `windows-latest`   | —                | —        |

The two `linux-<arch>-glibc` / `linux-<arch>-musl` artifacts both write
into `prebuilds/linux-<arch>/`; their files are disambiguated by the libc
tag prebuildify appends (`.glibc.node` vs `.musl.node`), and
node-gyp-build picks the right one at runtime by sniffing the consumer's
libc.

Anything outside the matrix above is **Tier 2 (source build) or
unsupported** — see [Support tiers](#support-tiers) above.

**Auxiliary workflows** that run alongside the two main matrices:

| Workflow                                                               | Trigger                         | What it does                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`codeql.yml`](./.github/workflows/codeql.yml)                         | per PR + weekly (Mon 06:00 UTC) | CodeQL `security-extended` against C/C++ binding + TypeScript surface                                         |
| [`fuzz.yml`](./.github/workflows/fuzz.yml)                             | nightly (03:00 UTC)             | fast-check property fuzz (`test/**/*.fuzz.ts`) at 5000 runs under ASan + UBSan                                |
| [`soak.yml`](./.github/workflows/soak.yml)                             | weekly                          | Large-graph soak (~50K nodes / 1–2M edges) on Linux                                                           |
| [`post-publish-smoke.yml`](./.github/workflows/post-publish-smoke.yml) | on release published + manual   | Installs the just-published `fast-leiden@<v>` from the npm registry on every Tier 1 platform and runs a smoke |
| [`vendor-update.yml`](./.github/workflows/vendor-update.yml)           | daily                           | Bumps the `vendor/igraph` + `vendor/libleidenalg` submodules and opens a PR if upstream advanced              |

### Node-API compatibility policy

The native addon is built against Node-API (N-API), which is the stable ABI
boundary. The `engines.node` constraint in `package.json` (`>=22`) reflects
which Node majors are actively tested in CI, not a hard ABI requirement.
Older Node majors will most likely load the addon but are not supported.

### Module system: ESM-only

`fast-leiden` is shipped as an **ES module**. `package.json` has
`"type": "module"` and the `"exports"` map exposes a single `import`
condition, so `require("fast-leiden")` from a plain CommonJS file will
fail with `ERR_REQUIRE_ESM` on older Nodes. On Node 22+ — which this
package's `engines.node` already requires — CommonJS callers can use
either of:

```ts
// 1. Top-level ESM (recommended)
import { leiden, leidenAsync } from "fast-leiden";
```

```js
// 2. Dynamic import from CJS (works everywhere)
const { leiden } = await import("fast-leiden");
```

```js
// 3. Synchronous require-of-ESM from CJS (Node 22+ behind
//    --experimental-require-module; on by default in Node 24+)
const { leiden } = require("fast-leiden");
```

The package's `"exports"` field locks the public API to the single `.`
subpath. Deep imports such as `import "fast-leiden/dist/native.js"` are
blocked at the loader level — the native binding is an internal
implementation detail. If you find yourself wanting one, please file an
issue describing the use case.

## Benchmark

A small bench script lives at `bench/basic.ts`. It generates a stochastic
block model graph, runs fast-leiden (sync + async), and — if a Python
environment with `igraph` and `leidenalg` is reachable — runs the same graph
through Python's leidenalg for comparison:

```bash
# optional: Python comparison
python3 -m venv bench/.venv
bench/.venv/bin/pip install igraph leidenalg

pnpm bench
```

## Repository layout

```
fast-leiden/
  src/                  TypeScript source — public API (ESM)
  native/               C++ N-API binding source
  scripts/
    install.mjs         install hook: prefer prebuild, fall back to source
    prebuild.mjs        run prebuildify --napi --strip for the host
    build-deps.mjs      Cross-platform CMake driver for igraph + libleidenalg
    write-version-header.mjs   generate native/version_generated.h
    clean.mjs           remove dist / build / prebuilds / vendor/build-deps
  vendor/
    igraph/             git submodule — igraph C library
    libleidenalg/       git submodule — libleidenalg C++ core
  prebuilds/            (generated) per-platform .node binaries
  test/
    *.test.ts           Vitest test suite (incl. fast-check properties)
    *.fuzz.ts           Long-running property fuzz (nightly only)
  bench/
    basic.ts            Synthetic SBM benchmark (incl. Python compare)
    perf-gate.ts        Per-PR perf regression gate (small graph)
    soak.ts             Weekly large-graph soak driver
  binding.gyp           node-gyp build descriptor
  tsconfig.json         TypeScript config (NodeNext / ESM)
  vitest.config.ts      Test runner config (coverage gate lives here)
  vitest.fuzz.config.ts Fuzz runner config (test/**/*.fuzz.ts)
```

## Known limitations

- **Source build needed off the prebuild matrix.** Prebuilds cover
  Linux x64 (glibc + musl), Linux arm64 (glibc + musl), macOS arm64,
  macOS x64, and Windows x64. Other targets (Windows arm64, FreeBSD, …)
  fall through to the source build at install time and need CMake + a
  C++17 toolchain + Python. See [Install model](#install-model).
- **Async input copy is synchronous.** The Leiden optimisation itself runs on
  a worker thread, but the JS→C++ copy of `sources`, `targets`, and `weights`
  happens on the JS thread before the worker is queued. For multi-million
  edge graphs this copy is non-trivial.
- **Cancellation is JS-side only (soft cancel).** `leidenAsync` /
  `leidenFromCsrAsync` accept an `AbortSignal`; on abort the returned
  Promise rejects with `signal.reason` immediately, but **the native
  worker thread keeps running until it completes**. CPU and memory are
  not released early. This is upstream-bounded — neither `igraph`'s
  error layer nor `libleidenalg`'s `optimise_partition` polls for
  cancellation during the inner loop — so it is a permanent contract
  for 1.x; see
  [Versioning and breaking-change policy](#versioning-and-breaking-change-policy).
  For a real CPU/memory deadline use Pattern C in
  [Recommended deploy patterns](#recommended-deploy-patterns).
- **No true parallelism inside one process.** Every call into the native
  side is serialized by a process-global mutex because `igraph`'s
  error-handling layer is not thread-safe. `leidenAsync` still gets you
  off the event loop, but `Promise.all([leidenAsync(...), leidenAsync(...)])`
  runs the two calls one after the other on the worker pool. For real
  parallel throughput, see Pattern B in
  [Recommended deploy patterns](#recommended-deploy-patterns). This
  constraint is part of the 1.x contract.
- **Community ids are not stable** across runs, seeds, or `libleidenalg`
  versions — only the partition (equivalence classes) is meaningful.
- **No streaming / chunked input.** The whole graph must fit in memory.
- **Large-graph soak runs weekly, not per-PR.** Every PR runs a
  lightweight perf gate (`bench/perf-gate.ts`, ~5K nodes / ~30K edges)
  so catastrophic regressions trip CI immediately; the larger soak
  graphs (`bench/soak.ts`, ~50K nodes / 1–2M edges) run on the weekly
  schedule defined in [`.github/workflows/soak.yml`](./.github/workflows/soak.yml).

## Troubleshooting

- **`Cannot find module .../build/Release/fast_leiden.node`** — the native
  addon hasn't been built yet, or was wiped by `pnpm clean`. Run
  `pnpm build` (or just `pnpm build:native` if vendor deps are already
  installed).
- **`build-deps: Found .../lib64/...`** — a stale `vendor/build-deps/install/`
  from before the libdir pin. Remove `vendor/build-deps` and rebuild.
- **`object file was built for newer macOS version`** — vendor deps were
  built against a different SDK / deployment target. The sentinel auto-
  detects host changes, but if you bump `MACOS_DEPLOYMENT_TARGET` in
  `scripts/build-deps.mjs` you should also bump
  `MACOSX_DEPLOYMENT_TARGET` in `binding.gyp`, then rebuild.
- **`pnpm install` fails on a CI / serverless image without CMake or
  Python** — your platform isn't on the [prebuild matrix](#install-model).
  Either provision a C++17 toolchain + Python + CMake on the image, or
  install on a supported platform and copy `node_modules/fast-leiden/` over.
- **`ERR_REQUIRE_ESM` when requiring `fast-leiden`** — the package is
  ESM-only. Use `import { leiden } from "fast-leiden"` from an ES module,
  `const { leiden } = await import("fast-leiden")` from CommonJS, or run
  on Node 24+ where synchronous `require()` of ESM works without a flag.
  See [Module system: ESM-only](#module-system-esm-only).

## Submodule update policy

`vendor/igraph` and `vendor/libleidenalg` are pinned via git submodule. The
currently pinned versions are:

<!-- vendor-versions:start -->

| Upstream                                                 | Pinned version |
| -------------------------------------------------------- | -------------- |
| [`igraph`](https://github.com/igraph/igraph)             | `1.0.1`        |
| [`libleidenalg`](https://github.com/vtraag/libleidenalg) | `0.12.0`       |

_Auto-updated by_ `.github/workflows/vendor-update.yml` _on the daily schedule._

<!-- vendor-versions:end -->

- A daily GitHub Actions cron (see
  [`.github/workflows/vendor-update.yml`](./.github/workflows/vendor-update.yml))
  checks both upstreams for a newer release, bumps the submodule + the
  `*_VERSION_FALLBACK` constants in `scripts/build-deps.mjs`, refreshes the
  table above, and opens an automated PR. CI must go green (Linux/macOS/
  Windows × Node 22 / 24 / 26 + ASan/UBSan) before we merge.
- If you depend on an upstream fix that hasn't landed yet, file an issue
  with the commit / release link and we'll prioritise.
- Submodule bumps that change deterministic partition output, ABI, or
  observable behaviour are called out in [`CHANGELOG.md`](./CHANGELOG.md).
  Pre-1.0, these can land in any **minor** release; once we cut 1.0 they
  become major bumps.

## Versioning and breaking-change policy

`fast-leiden` follows Semantic Versioning from `1.0.0` onwards. The
public API surface defined below is the SemVer contract: anything
inside it stays compatible within a major; anything outside it can
change in any release.

- **Patch (`X.Y.Z`)**: bug fixes and submodule bumps that do not change
  the deterministic partition for a given input + seed +
  `libleidenalg` version.
- **Minor (`X.Y.0`)**: additive changes (new exported function, new
  option field, expanded prebuild matrix). Submodule bumps that
  observably change the partition output but do not change the public
  API shape also land in minors and are called out in
  [`CHANGELOG.md`](./CHANGELOG.md).
- **Major (`X.0.0`)**: removing or renaming a public export, changing
  the type of an option, narrowing accepted input shapes, dropping a
  Tier 1 platform, or any other source-breaking change.

The 1.0 release locks the following behaviours into the SemVer contract:

- **`AbortSignal` is a soft cancel for the lifetime of 1.x.** It
  unblocks the awaiting JS code immediately; it does **not** stop the
  native worker thread. This is upstream-bounded — neither `igraph`'s
  interruption protocol nor `libleidenalg`'s optimiser polls for
  cancellation during `optimise_partition`, so a real CPU/memory
  deadline requires process isolation (see
  [Recommended deploy patterns](#recommended-deploy-patterns)). If
  upstream adds cooperative cancellation, we will add a hard-cancel
  opt-in in a **minor** release; the soft-cancel contract still
  remains the default through 1.x for backwards compatibility.
- **Process-global serialization is permanent for 1.x.** Every call
  into the native side (sync or async) is serialized by a
  process-global mutex because `igraph`'s error layer is not
  thread-safe. Parallel throughput requires multiple processes or
  multiple `worker_threads` (each loads its own addon copy). We do
  not plan to relax this within 1.x; if we ever do, it will be a
  minor (additive) release that keeps the current single-instance
  behaviour as the default.

### Public API surface (the SemVer contract)

For the purposes of SemVer, the **public API surface** is exactly:

- The five named exports from the package root: `leiden`,
  `leidenFromCsr`, `leidenAsync`, `leidenFromCsrAsync`, `version`.
- The types in [`src/types.ts`](./src/types.ts) re-exported from
  `src/index.ts` (`LeidenInput`, `LeidenCsrInput`, `LeidenOptions`,
  `LeidenQualityFunction`, `LeidenResult`).
- The behaviour documented in [API contract](#api-contract),
  [Async semantics](#async-semantics), and [Output shape](#output-shape).

The following are **not** part of the public API and may change in any
release without a major bump:

- `dist/native.js` and anything under `dist/` except `dist/index.{js,d.ts}`.
  Deep imports are blocked by the `"exports"` field in `package.json`.
- The C++ ABI of the bundled `.node` files. These are an internal
  implementation detail; consumers should never `dlopen` them directly.
- The format of `prebuilds/` filenames and the `node-gyp-build` lookup
  protocol; these can change as long as the public `import` keeps
  working on the supported platforms.
- The CLI surface of `scripts/*.mjs`. Build scripts are not a contract.
- The output of `pnpm bench` and `pnpm soak` (formats, columns, file
  layout); they're for our CI, not for downstream tooling.
- The exact community ids in `membership` — only the partition (the
  equivalence classes) is part of the contract.

### Public API surface (the SemVer contract)

For the purposes of SemVer, the **public API surface** is exactly:

- The five named exports listed above.
- The types in [`src/types.ts`](./src/types.ts) re-exported from
  `src/index.ts` (`LeidenInput`, `LeidenCsrInput`, `LeidenOptions`,
  `LeidenQualityFunction`, `LeidenResult`).
- The behaviour documented in [API contract](#api-contract),
  [Async semantics](#async-semantics), and [Output shape](#output-shape).

The following are **not** part of the public API and may change in any
release without a major bump:

- `dist/native.js` and anything under `dist/` except `dist/index.{js,d.ts}`.
  Deep imports are blocked by the `"exports"` field in `package.json`.
- The C++ ABI of the bundled `.node` files. These are an internal
  implementation detail; consumers should never `dlopen` them directly.
- The format of `prebuilds/` filenames and the `node-gyp-build` lookup
  protocol; these can change as long as the public `import` keeps
  working on the supported platforms.
- The CLI surface of `scripts/*.mjs`. Build scripts are not a contract.
- The output of `pnpm bench` and `pnpm soak` (formats, columns, file
  layout); they're for our CI, not for downstream tooling.
- The exact community ids in `membership` — only the partition (the
  equivalence classes) is part of the contract.

## License

**GPL-3.0-or-later** — see [`LICENSE`](./LICENSE).

This package statically links against `igraph` (GPL-2.0-or-later) and
`libleidenalg` (GPL-3.0-or-later). The combined work is distributed under
GPL-3.0-or-later to respect both upstream licenses.

> ⚠️ **The GPL has substantial consequences for downstream users.** In
> particular, distributing software that links against `fast-leiden` —
> directly or transitively — generally obligates you to make the _combined_
> work available under GPL-3.0-or-later. This is independent of how
> "production-ready" the code is technically; it is a licensing decision
> made by `igraph` and `libleidenalg` upstream, and we inherit it.
>
> If your project cannot ship under GPL, you should not depend on
> `fast-leiden`. Consult a lawyer for any non-trivial deployment.
