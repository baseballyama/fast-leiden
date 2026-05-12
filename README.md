# fast-leiden

> **Fast Leiden community detection for Node.js, powered by native igraph/leidenalg bindings.**

`fast-leiden` runs the Leiden community-detection algorithm directly inside a
Node.js process, without spawning a Python worker. It wraps the C/C++ reference
implementations of [`igraph`](https://igraph.org/) and
[`leidenalg`](https://github.com/vtraag/leidenalg) via N-API and exposes a
TypeScript-first API that prefers `Uint32Array` / `Float64Array` for low-copy
data transfer on large graphs.

## Status

Early scaffolding. The TypeScript surface and the native binding skeleton are in
place; the actual igraph / leidenalg integration is being built out
incrementally. See [`CLAUDE.md`](./CLAUDE.md) for the project plan and
implementation steps.

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

## Planned API

```ts
import { leiden, leidenFromCsr } from "fast-leiden";

// Edge-list input
const result = leiden({
  nodeCount,
  sources, // Uint32Array
  targets, // Uint32Array
  weights, // optional Float64Array
});

// CSR input — preferred for large graphs
const resultCsr = leidenFromCsr({
  nodeCount,
  offsets, // Uint32Array, length nodeCount + 1
  targets, // Uint32Array
  weights, // optional Float64Array
});

// result.membership is a Uint32Array (community id per node)
// result.quality is the final quality score
// result.iterations is how many iterations the algorithm ran
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
pnpm build
pnpm test
```

If you already cloned without `--recursive`, fetch the submodules:

```bash
git submodule update --init --recursive
```

## Build requirements

- Node.js >= 20
- A C++17 toolchain (Xcode CLT on macOS, build-essential on Linux, MSVC on
  Windows)
- Python 3 (for `node-gyp`)

## Repository layout

```
fast-leiden/
  src/              TypeScript source — public API
  native/           C++ N-API binding source
  vendor/
    igraph/         git submodule — igraph C library
    leidenalg/      git submodule — leidenalg C++ library
  test/             Unit tests
  bench/            Micro-benchmarks
  binding.gyp       node-gyp build descriptor
  tsconfig.json     TypeScript config
```

## License

[GPL-3.0-or-later](./LICENSE).

This package links against `igraph` (GPL-2.0-or-later) and `leidenalg`
(GPL-3.0-or-later). The combined work is distributed under GPL-3.0-or-later to
respect both upstream licenses.
