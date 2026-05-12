---
"fast-leiden": major
---

**1.0 — first stable release.** The public API documented in
`README.md` is now under SemVer; everything outside it is internal
and may change at any time.

This release consolidates every change accumulated in `0.x` — TypedArray
inputs, the CSR fast path, async variants on libuv worker threads,
`AbortSignal` soft cancel, prebuilt binaries for seven artifacts /
five platform directories, the process-global mutex serializing every
native call, ESM-only packaging — into the 1.0 contract.

What 1.0 newly guarantees on top of the existing behaviour:

- **Versioning policy is fixed.** The "Public API surface" section in
  `README.md` enumerates the SemVer contract: five exported functions,
  the five re-exported types, and the documented behaviour. Anything
  not on that list (deep imports, native ABI, prebuild filenames,
  build-script CLI, bench / soak output) is explicitly out of scope.
- **Soft-cancel is the permanent contract for 1.x.** Upstream
  `libleidenalg` does not poll for interruption inside
  `optimise_partition`, so `AbortSignal` will keep unblocking the
  awaiting JS code immediately while the native worker thread runs
  to completion. For a real CPU/memory deadline use Pattern C in the
  new "Recommended deploy patterns" section.
- **Process-global serialization is the permanent contract for 1.x.**
  `igraph`'s error layer is not thread-safe; every call into the
  native side (sync or async) holds the same lock. Parallel
  throughput requires multiple `worker_threads` or processes.
- **Tier 1 / Tier 2 / unsupported platforms are spelled out.** Tier 1
  means prebuilt binaries and full CI; Tier 2 falls through to source
  build (best-effort); unsupported targets get no help. A regression
  on any Tier 1 target blocks a release.

New quality gates that land with 1.0:

- **Per-PR perf gate** (`bench/perf-gate.ts`, ~5K nodes / ~30K edges)
  runs on every CI matrix entry; a 5× regression in the inner loop
  trips the budget. The weekly large-graph soak in
  `.github/workflows/soak.yml` still covers the bigger graphs.
- **Coverage gate** (≥ 85% lines / 85% statements / 90% functions /
  80% branches on `src/**`) enforced by `vitest run --coverage` in
  the static-checks job.
- **Nightly fuzz** (`.github/workflows/fuzz.yml`) runs the fast-check
  property suite at 5000 numRuns with ASan + UBSan instrumentation,
  guarding the JS/C++ boundary against memory-safety regressions.
- **Post-publish smoke** (`.github/workflows/post-publish-smoke.yml`)
  installs the package from the npm registry into a fresh container
  on every Tier 1 platform after each release and runs the smoke
  test, catching registry-side packaging holes that don't show up
  in `pack-install`.
- **SBOM** in the release workflow. `release.yml` generates a
  CycloneDX 1.5 SBOM for the production dependency tree and uploads
  it as a long-retention artifact alongside the published tarball
  and npm provenance.

`SECURITY.md` is updated to drop the pre-1.0 language and describe
the post-1.0 patch-line policy. `README.md` removes the "not yet
published" install banner.

CI fixes that go in with this cut:

- **Windows test + prebuild jobs now install bison/flex.** Upstream
  `igraph`'s `src/CMakeLists.txt` unconditionally invokes
  `bison_target()` / `flex_target()` (no pre-generated parser sources
  in the submodule), so without these tools the CMake configure step
  died with `Unknown CMake command "bison_target"`. We install
  `winflexbison3` via Chocolatey and point CMake at
  `win_bison.exe` / `win_flex.exe` through `BISON_EXECUTABLE` /
  `FLEX_EXECUTABLE`. Applied to `ci.yml`, `release.yml` (prebuild
  matrix), and `prebuilds.yml`.
- **Tarball install now ships `vendor/igraph/doc/CMakeLists.txt`.** The
  earlier "slim tarball" change stripped the whole `doc/` directory,
  but igraph's top-level CMakeLists.txt unconditionally calls
  `add_subdirectory(doc)` when igraph is the top-level project. The
  fix is to ship just the CMakeLists.txt — the XML / examples it
  references are only consumed by `make doc` / `make pdf` targets we
  never invoke.
- **`scripts/build-deps.mjs` passes `-DBUILD_TESTING=OFF`.** Upstream
  igraph's `include(CTest)` flips `BUILD_TESTING` to ON by default,
  which would then pull in `add_subdirectory(tests)`. We never run
  igraph's own test suite, and `tests/` is correctly stripped from
  the tarball, so the safest path is to turn the option off
  explicitly.
