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

Pre-1.0. Working end-to-end on macOS, Linux, and Windows in CI (Node 22 / 24 /
26). Modularity and CPM quality functions are supported. Both edge-list and
CSR input paths are implemented. See [Supported platforms](#supported-platforms)
and [Known limitations](#known-limitations) before adopting in production.

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

When the signal aborts, the returned Promise rejects **immediately** with
`signal.reason` (an `AbortError` by default). The native worker thread may
continue running until it completes — we don't yet propagate the cancel into
`libleidenalg` — but the JS-side handle is released and the worker's result
is silently discarded. If you need a hard CPU-and-memory deadline (not just
a "your code unblocks" deadline), run the caller in a `worker_threads`
worker or a child process that you can terminate.

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

## Install

> Not yet published. The package will be available as `fast-leiden` on npm once
> the initial release is cut.

### Install model

The npm tarball ships **prebuilt binaries via [`prebuildify`](https://github.com/prebuild/prebuildify)**
for the platforms in our release matrix:

| Platform               | Status                                     |
| ---------------------- | ------------------------------------------ |
| `linux-x64`            | ✅ prebuilt                                |
| `darwin-arm64`         | ✅ prebuilt                                |
| `darwin-x64`           | ✅ prebuilt                                |
| `win32-x64`            | ✅ prebuilt                                |
| `linux-arm64`, musl, … | ❌ not yet — file an issue if you need one |

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

CI matrix (see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)):

| OS             | Node 22 | Node 24 | Node 26 | Notes                               |
| -------------- | ------- | ------- | ------- | ----------------------------------- |
| ubuntu-latest  | ✅      | ✅      | ✅      | glibc; built against the runner SDK |
| macos-latest   | ✅      | ✅      | ✅      | arm64; deployment target 11.0       |
| windows-latest | ✅      | ✅      | ✅      | x64; MSVC                           |

In addition:

- **Linux musl (Alpine, distroless musl images)** is not currently part of CI.
  The source build _should_ work given a musl C++17 toolchain, CMake, and
  Python, but it is not validated on every commit. If you depend on musl,
  please file an issue so we can wire it into CI.
- **macOS x64** is no longer tested directly (`macos-latest` is arm64 on
  GitHub Actions). The build is universal-2-compatible in theory but the
  arm64 / x64 split is not exercised here.
- **Linux arm64** is not currently part of CI.

### Node-API compatibility policy

The native addon is built against Node-API (N-API), which is the stable ABI
boundary. The `engines.node` constraint in `package.json` (`>=22`) reflects
which Node majors are actively tested in CI, not a hard ABI requirement.
Older Node majors will most likely load the addon but are not supported.

### CJS / ESM

The compiled output under `dist/` is **CommonJS** (the package has no
`"type": "module"` field). Both styles work for consumers:

```ts
// TypeScript or ESM Node — works via default-export interop
import { leiden } from "fast-leiden";
```

```js
// CommonJS Node
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
  src/                  TypeScript source — public API
  native/               C++ N-API binding source
  scripts/
    build-deps.mjs      Cross-platform CMake driver for igraph + libleidenalg
  vendor/
    igraph/             git submodule — igraph C library
    libleidenalg/       git submodule — libleidenalg C++ core
  test/                 Vitest test suite
  bench/                Micro-benchmarks
  binding.gyp           node-gyp build descriptor
  tsconfig.json         TypeScript config
```

## Known limitations

- **Source build needed off the prebuild matrix.** Prebuilds cover
  `linux-x64`, `darwin-arm64`, `darwin-x64`, and `win32-x64`. Other targets
  (Linux arm64, musl, FreeBSD …) fall through to the source build at install
  time and need CMake + a C++17 toolchain + Python. See
  [Install model](#install-model).
- **Async input copy is synchronous.** The Leiden optimisation itself runs on
  a worker thread, but the JS→C++ copy of `sources`, `targets`, and `weights`
  happens on the JS thread before the worker is queued. For multi-million
  edge graphs this copy is non-trivial.
- **Cancellation is JS-side only.** `leidenAsync` / `leidenFromCsrAsync`
  accept an `AbortSignal`; on abort the returned Promise rejects with
  `signal.reason` immediately, but the native worker keeps running to
  completion (we don't yet propagate the cancel into libleidenalg). Wasted
  CPU is bounded by the size of the graph, but if you need a hard deadline
  for very large graphs, run the caller in a child process you can terminate.
- **Community ids are not stable** across runs, seeds, or `libleidenalg`
  versions — only the partition (equivalence classes) is meaningful.
- **No streaming / chunked input.** The whole graph must fit in memory.
- **Performance regression and large-graph soak tests are not yet part of
  CI.** Property-based fuzzing of the validator boundary runs in CI via
  `fast-check`. If you have a representative large graph you can share for
  perf testing, please open an issue.

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
  Python** — there are no prebuilt binaries yet; either provision the
  toolchain or wait for the `prebuild`-based release. Track the roadmap in
  [Install model and roadmap](#install-model-and-roadmap).

## Submodule update policy

`vendor/igraph` and `vendor/libleidenalg` are pinned via git submodule. We
**follow upstream on a best-effort basis**:

- We bump submodules when an upstream release fixes a bug we hit, ships a
  security fix, or adds a feature we need. There is **no fixed cadence**.
- If upstream lands a fix you care about, file an issue with the commit /
  release link and we'll prioritise the bump.
- Submodule bumps that change deterministic partition output, ABI, or
  behaviour are called out in [`CHANGELOG.md`](./CHANGELOG.md). Pre-1.0,
  these can land in any **minor** release; once we cut 1.0 they become
  major bumps.
- Each bump goes through the full CI matrix (Linux/macOS/Windows × Node
  22 / 24 / 26 plus the ASan/UBSan job) before merge.

## Versioning and breaking-change policy

Pre-1.0. We follow Semantic Versioning with the standard pre-1.0 caveat:
**breaking changes can land in any minor (`0.Y.0`) release**, but every
breaking change is called out in [`CHANGELOG.md`](./CHANGELOG.md) with the
migration. Patch (`0.0.Z`) releases are non-breaking. Once we cut 1.0, the
public API documented in this README becomes the SemVer surface.

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
