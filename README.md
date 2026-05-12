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

Working end-to-end on macOS and Linux. Modularity and CPM quality functions are
supported. Both edge-list and CSR input paths are implemented.

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

## Install

> Not yet published. The package will be available as `fast-leiden` on npm once
> the initial release is cut.

### Install model and roadmap

Today the npm package ships the `igraph` and `libleidenalg` sources under
`vendor/`, and the `install` lifecycle hook runs CMake + the C++ toolchain on
the consumer's machine to produce the `.node` addon. That means every install
requires CMake, a C++17 compiler, and Python (for `node-gyp`) — and the first
install takes several minutes.

This is a deliberate trade-off for the early releases (it keeps the package
small, auditable, and works on any platform the toolchain supports), not a
long-term goal. **Prebuilt binaries via `prebuild` / `prebuild-install` are on
the roadmap** before 1.0; once those land, the source build will become an
opt-in fallback rather than the default.

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
reuse the install tree under `vendor/build-deps/install/`.

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

## License

[GPL-3.0-or-later](./LICENSE).

This package links against `igraph` (GPL-2.0-or-later) and `libleidenalg`
(GPL-3.0-or-later). The combined work is distributed under GPL-3.0-or-later to
respect both upstream licenses.
