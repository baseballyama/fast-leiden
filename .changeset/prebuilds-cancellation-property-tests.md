---
"fast-leiden": minor
---

Ship prebuilt binaries, add AbortSignal cancellation, property-based tests,
and a submodule update policy.

- **Prebuilt binaries.** The npm tarball now ships `.node` files for
  `linux-x64`, `darwin-arm64`, `darwin-x64`, and `win32-x64` under
  `prebuilds/<platform>-<arch>/`. `scripts/install.mjs` uses
  [`node-gyp-build`](https://github.com/prebuild/node-gyp-build) to pick up
  the matching prebuild at install time; consumers on the matrix no longer
  need CMake, Python, or a C++ toolchain. Targets outside the matrix still
  fall through to the existing source build (CMake + `node-gyp rebuild`).
  Adds a `.github/workflows/prebuilds.yml` matrix that builds every
  platform on every tag push and uploads the binaries as artifacts; a
  follow-up `smoke` job per-platform then `pnpm pack`s the tarball with
  the artifact dropped in, installs it into a fresh project, asserts
  `build/Release/` was *not* produced (proving the prebuild was used),
  and runs the public API.
- **`AbortSignal` cancellation on async calls.** `LeidenOptions` gains a
  `signal?: AbortSignal` field, respected by `leidenAsync` and
  `leidenFromCsrAsync`. When the signal aborts, the returned Promise
  rejects immediately with `signal.reason` (an `AbortError` by default,
  or `signal.timeout()`'s `TimeoutError`). The native worker thread keeps
  running until it completes — we don't yet propagate the cancel into
  `libleidenalg` — but the JS handle is released and the worker's result
  is silently discarded. Works with both `AbortController` and
  `AbortSignal.timeout()`. Adds 8 test cases in
  `test/cancel.test.ts`. Synchronous calls cannot be cancelled (they run
  on the JS thread) and ignore the `signal` field.
- **Property-based fuzz tests via `fast-check`.** New
  `test/property.test.ts` generates random valid edge lists, valid CSR
  shapes, and intentionally malformed CSR; asserts that valid inputs
  produce well-formed partitions, that runs with the same seed are
  reproducible, that malformed CSR throws (never crashes), and that
  wrong-element-type TypedArrays are rejected. The native addon is
  exercised under ASan + UBSan in CI (see `sanitizers` job), so any
  out-of-bounds access during these random runs surfaces there.
- **Submodule update policy.** README documents that we follow upstream
  `igraph` and `libleidenalg` on a best-effort basis (no fixed cadence;
  triggered by upstream CVE / bug fix / needed feature), and that
  submodule bumps affecting partition output are called out as minor
  releases pre-1.0.

Test count: 71 → 84.
