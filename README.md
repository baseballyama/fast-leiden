# fast-leiden

> **Fast Leiden community detection for Node.js, powered by native igraph/libleidenalg bindings.**

`fast-leiden` runs the Leiden community-detection algorithm directly inside a
Node.js process, without spawning a Python worker. It wraps the C/C++ reference
implementations of [`igraph`](https://igraph.org/) and
[`libleidenalg`](https://github.com/vtraag/libleidenalg) (the C++ core extracted
from [`leidenalg`](https://github.com/vtraag/leidenalg)) via N-API and exposes a
TypeScript-first API that prefers `Uint32Array` / `Float64Array` for zero-copy
data transfer on large graphs.

## Status

Working end-to-end on macOS and Linux. Modularity and CPM quality functions are
supported. Both edge-list and CSR input paths are implemented.

## Goals

- Run Leiden from a Node.js server without a Python sidecar.
- Provide an ergonomic TypeScript API for large graphs.
- Prefer TypedArray (`Uint32Array` / `Float64Array`) inputs and outputs to
  minimize copies.
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

// CSR input — preferred for large graphs
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

See [`src/types.ts`](./src/types.ts) for the full type definitions.

## Install

> Not yet published. The package will be available as `fast-leiden` on npm once
> the initial release is cut.

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

## Build requirements

- Node.js >= 20
- A C++17 toolchain (Xcode CLT on macOS, `build-essential` on Linux, MSVC on
  Windows)
- CMake >= 3.23 (the requirement comes from `libleidenalg`)
- Python 3 (for `node-gyp`)

## Repository layout

```
fast-leiden/
  src/                  TypeScript source — public API
  native/               C++ N-API binding source
  scripts/
    build-deps.sh       Builds igraph + libleidenalg into vendor/build-deps
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
