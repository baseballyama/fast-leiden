# Changelog

## 1.0.1

### Patch Changes

- 2fe986a: Slim the published tarball down to what Tier 1 consumers actually need: `dist/`, `prebuilds/`, `LICENSE`, `README.md`, `SECURITY.md`. The vendored upstream sources (`vendor/`), the `native/` C++ source, `binding.gyp`, and the `scripts/` helpers are no longer shipped, and the `install` lifecycle hook is removed — `node-gyp-build` resolves the prebuilt addon at `require()` time directly.

  Unpacked tarball size drops from ~16 MB to ~500 kB (single-prebuild) / ~2.6 MB (full matrix). Tier 1 platforms (`linux-{x64,arm64}` glibc/musl, `darwin-arm64`, `win32-x64`) are unaffected. Tier 2 platforms that previously relied on the install-time source-build fallback (notably `darwin-x64` Intel Mac) now need to install from a `--recursive` git clone and run `pnpm build`; the README has been updated accordingly.

## 1.0.0

### Major Changes

- f51b89c: **1.0 — first stable release.** The public API documented in
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
    on any Tier 1 target blocks a release. `darwin-x64` (Intel Mac) is
    Tier 2 because GitHub retired the `macos-13` runner; users build from
    source.

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
    CycloneDX 1.5 SBOM for the production dependency tree, uploads it
    as a 365-day workflow artifact, and attaches it to the GitHub
    Release as a permanent public asset alongside the published
    tarball and npm provenance.
  - **CodeQL** (`.github/workflows/codeql.yml`) runs the
    `security-extended` query packs against both the C/C++ binding
    (with a real `pnpm build` so CodeQL can observe the compiler
    invocations) and the TypeScript surface on every PR + weekly.

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
  - **Windows MSVC CRT alignment.** node-gyp builds `binding.obj` with
    `/MT` (static CRT), but igraph + libleidenalg defaulted to `/MD`
    (dynamic CRT), so the Windows link step died with LNK2038
    `RuntimeLibrary` mismatches and a cascade of `__imp_*`
    unresolved-externals. We pin both ends: `binding.gyp` sets
    `RuntimeLibrary: "0"` (static release), and `scripts/build-deps.mjs`
    passes `-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded` so igraph and
    libleidenalg produce matching `/MT` `.lib`s. The cache sentinel
    schemaVersion is bumped to 2 so any pre-existing `/MD` install
    trees are wiped on next build.
  - **`scripts/build-deps.mjs` no longer dirties `vendor/libleidenalg`.**
    The script used to unconditionally write a fallback `VERSION` file
    into each submodule, which left `?? VERSION` in `git status` on
    every local build. It now only writes the file when `git describe
--tags` can't resolve a CMake-compatible version (the
    tarball-install and shallow-CI paths); on a full local clone
    upstream's own CMake handles versioning and the submodule stays
    clean.
  - **Prebuild matrix step-level gating fixed.** The `Note Release-PR
path` step's `shell: bash` died on the musl rows because
    `node:22-alpine` doesn't ship bash until our `Install Alpine build
deps` step adds it; we now use `shell: sh` for that note step so the
    matrix label renders cleanly on Release-PR runs (without the
    job-level `if:` that would have collapsed the matrix UI to a literal
    `Prebuild ${{ matrix.artifact }}` row).
  - **`darwin-x64` dropped from the prebuild matrix.** macos-13 retire +
    free macOS runners being arm64-only meant the row could never
    succeed. Intel Mac users now get the source-build path; see
    README "Support tiers".
  - **CodeQL excludes `vendor/`.** The vendored igraph + libleidenalg
    sources are still observed during the build trace (CodeQL needs
    them to resolve symbols), but findings against them aren't filed
    against us. `node_modules`, `build`, `dist`, `prebuilds`, and
    `coverage` are excluded for the same reason.
  - **`.github/dependabot.yml` removed.** It was a leftover template
    stub with an empty `package-ecosystem` value that failed the
    Dependabot config check on every push. `renovate.json` is the
    active dep updater.
  - **Bulk-bumped non-major npm deps + first-party GitHub Actions to
    current majors.** node-addon-api ^8.2.0 → ^8.7.0, @changesets/cli
    ^2.27.10 → ^2.31.0, @types/node ^24.0.0 → ^24.12.4, @vitest/coverage-v8
    - vitest ^2.1.6 → ^2.1.9, node-gyp ^11.0.0 → ^11.5.0, packageManager
      pnpm@9.15.0 → 9.15.9; actions/checkout @v4 → @v6, actions/setup-node
      @v4 → @v6, actions/cache @v4 → @v5, actions/upload-artifact @v4 →
      @v7, actions/download-artifact @v4 → @v8, actions/github-script @v7
      → @v9, pnpm/action-setup @v4 → @v6, peter-evans/create-pull-request
      @v7 → @v8. Resolves the Node.js 20 deprecation warnings on every CI
      run.

### Minor Changes

- ae17cb6: **ESM-only.** `fast-leiden` is now shipped exclusively as an ES module.

  - `package.json` gains `"type": "module"`, and the `"exports"` map's `.`
    subpath now exposes only the `import` condition (was `default`). The
    `dist/` output that `tsc` emits is real ESM (`import` / `export`
    statements, not `require` / `module.exports`).
  - CJS callers can still consume the package on Node 22+ via
    `await import("fast-leiden")` from a CommonJS file, or via
    `require("fast-leiden")` on Node 22+ with `--experimental-require-module`
    / on Node 24+ where it's enabled by default. A plain `require()` on
    older Node majors now fails with `ERR_REQUIRE_ESM` — that's the
    intentional consequence of `import`-only `exports`.
  - `src/index.ts` and `src/native.ts` no longer reference CommonJS
    globals (`__filename`, `__dirname`). `createRequire` is now anchored
    at `import.meta.url`, and `src/native.ts` derives `projectRoot` via
    `fileURLToPath(import.meta.url)`. The native binding still resolves
    through `node-gyp-build` (a CJS module pulled in via `createRequire`).
  - README has been retitled "Module system: ESM-only" with three concrete
    consumption recipes (top-level ESM `import`, dynamic `import()` from
    CJS, `require()` on Node 22+). The Status header now states the
    module system up front, and Troubleshooting calls out `ERR_REQUIRE_ESM`
    with the three workarounds.

  No behaviour changes to the public API. All 84 tests still pass.

- 4d1398d: Expand the prebuild matrix, add a weekly large-graph soak workflow, and
  trim the published tarball.

  - **Prebuild matrix grows to 7 artifacts / 5 platform directories.** New
    targets: `linux-x64-musl` (Alpine via `node:22-alpine` container),
    `linux-arm64-glibc` (via `ubuntu-24.04-arm`), `linux-arm64-musl` (via
    `ubuntu-24.04-arm` + `node:22-alpine`). prebuildify is called with
    `--tag-libc` on Linux so glibc and musl prebuilds coexist under
    `prebuilds/linux-<arch>/` and `node-gyp-build` picks the right one at
    runtime by sniffing the consumer's libc.

  - **Release-workflow UI fix.** The `prebuild` matrix job no longer carries
    a job-level `if:`, which previously caused GitHub Actions to render
    `Prebuild ${{ matrix.target }} — Skipped` as a single literal row on
    Release-PR runs. The matrix now expands fully (each target gets its
    own labelled row) and the actual work is gated step-by-step inside
    each entry. Same for the `publish` job.

  - **CI matrix UI fix.** `Test (Node … / …)` and `Tarball install
(Node … / …)` no longer `needs: static`. GitHub Actions does not
    expand a matrix when its dependency is skipped, so any `static`
    failure (format / lint / typecheck) used to collapse all 9 + 4
    matrix rows into one literal `${{ matrix.* }}` "Skipped" row. The
    matrix now expands unconditionally; the extra parallel runs cost a
    few CI minutes per failed push but keep the run page legible.

  - **Weekly soak workflow.** New `.github/workflows/soak.yml` (cron: every
    Sunday 12:00 UTC, also `workflow_dispatch`) runs `bench/soak.ts` on a
    large stochastic-block-model graph and uploads the wall-time / RSS
    summary as an artifact. Covers Linux x64 and macOS arm64. Bench
    inputs can be overridden on manual dispatch.

  - **Tarball trimming.** `package.json#files` is now an explicit subpath
    list inside `vendor/igraph` and `vendor/libleidenalg`, so the
    upstream `tests/`, `examples/`, `doc/`, `fuzzing/`, `.github/`,
    `.azure/`, and similar non-build paths no longer ship to npm. Source
    build still works — everything CMake actually reads is kept.
    Packed: 4.4 MB → 3.4 MB. Unpacked: 21.9 MB → 16.7 MB. File count:
    2740 → 1388.

  - **Install-hook fix.** `scripts/build-deps.mjs` no longer writes a short
    SHA into the upstream VERSION file when the submodule was checked out
    shallow. `git describe --tags --always` on a shallow clone (CI default
    `fetch-depth: 1`, no tags fetched) returns a SHA, and CMake's
    `project(VERSION ...)` rejects it. The script now drops `--always`,
    strips `v` prefix and `-N-gSHA` suffix, validates against
    `/^\d+(\.\d+){0,3}$/`, and falls back to the in-script constants.
    Stopped the Tarball-install CI job from dying with `VERSION
"d03122b" format invalid`.

- 737000f: Production-readiness pass: native serialization, hardened release flow,
  automated vendor updates, and the operational maturity files.

  - **Serialize every call into igraph / libleidenalg.** `igraph`'s
    error-handling layer is explicitly not thread-safe
    (`vendor/igraph/include/igraph_error.h`). The native binding now holds
    a process-global `std::mutex` around `RunLeidenJob`, so any mix of
    `leiden`, `leidenAsync`, `leidenFromCsr`, and `leidenFromCsrAsync`
    calls — across the JS thread and the libuv worker pool — runs one at
    a time. `Promise.all([leidenAsync(...), …])` still finishes (no
    crashes, no torn state), but the underlying compute is sequenced.
    Documented in README "Async semantics" and "Known limitations".
  - **Concurrency tests.** New `test/concurrent.test.ts` (5 cases):
    Promise.all of 8 / 32 / 100 async calls, sync + async interleaved,
    and parallel CSR calls. Without the mutex these would race the
    upstream error state under ASan/UBSan.
  - **Vitest pinned to a serial pool.** `vitest.config.ts` now uses
    `pool: "forks"`, `fileParallelism: false`, and `sequence.concurrent: false`.
    The native addon plus the upstream global error handler make per-file
    parallelism a flake source; one fork per file isolates each test file
    cleanly.
  - **Release workflow rebuilt around the prebuild matrix.**
    `.github/workflows/release.yml` now has four jobs — `check`,
    `release-pr`, `prebuild` (matrix), `publish`. When a Version Packages
    PR merges, the publish job downloads every platform artifact, verifies
    none of `linux-x64 / darwin-arm64 / darwin-x64 / win32-x64` is missing,
    inspects the packed tarball, and only then calls `changeset publish`.
    Missing prebuild → publish aborts. `prebuilds.yml` is retained as a
    manual `workflow_dispatch` for pipeline verification.
  - **Daily upstream watcher.** `.github/workflows/vendor-update.yml` runs
    daily (06:00 UTC). `scripts/bump-vendor.mjs` queries the latest GitHub
    release for `igraph` and `libleidenalg`, checks out the tag inside the
    submodule, updates the `*_VERSION_FALLBACK` constants in
    `scripts/build-deps.mjs`, and rewrites the README "Vendored upstream"
    table between the `<!-- vendor-versions:start -->` / `:end -->`
    markers. If anything changed, the workflow opens a `chore/vendor-update`
    PR — never auto-merged, because a submodule bump can shift partition
    output deterministically.
  - **Soft-cancel AbortSignal contract.** README async section now
    flags the cancel as soft (the worker keeps running until done; only
    the JS handle releases) with a prominent ⚠️ callout and a concrete
    workaround pattern (worker_threads / child_process).
  - **Operational files.** Added `SECURITY.md` (private vulnerability
    reporting via GitHub Security Advisories), `.github/CODEOWNERS`
    (review routing), and `renovate.json` (grouped devDependency bumps,
    native deps never auto-merge, vendor/ ignored, weekly lock-file
    maintenance).

  Test count: 84 → 89, all passing.

- 9b25d89: Ship prebuilt binaries, add AbortSignal cancellation, property-based tests,
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
    `build/Release/` was _not_ produced (proving the prebuild was used),
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

### Patch Changes

- e561a85: Reject non-finite `weights` values, unify `version()` with `package.json`, and add a dist smoke test.

  - **Validate finite `weights`**: `leiden()` and `leidenFromCsr()` now throw a
    `RangeError` if any element of `weights` is `NaN`, `Infinity`, or `-Infinity`.
    Previously these values flowed through to libleidenalg and surfaced as
    `quality: NaN`, silently corrupting the partition score. The check happens
    on both the TypeScript side (clear error) and the C++ side (defence in depth
    for callers bypassing the public API).
  - **Single source for `version()`**: `version()` is now read from
    `package.json` at runtime, and the native side picks up the same string at
    compile time from a generated header (`scripts/write-version-header.mjs`).
    Bumping the package version no longer requires touching `native/binding.cc`,
    and the test suite asserts that all three (TS API, native API, `package.json`)
    agree.
  - **Dist smoke test**: `test/dist-smoke.test.ts` loads the compiled
    `dist/index.js` directly and exercises the public API. CI now catches
    source-vs-dist drift, broken `main` resolution, and missing exports.
  - **CPM + directed coverage**: added positive-path tests for
    `qualityFunction: "cpm"` and `directed: true`, both of which were previously
    only covered indirectly.
  - **Install UX**: README now states that prebuilt binaries via `prebuild` are
    on the roadmap before 1.0; the current source build is documented as a
    deliberate early-release trade-off rather than the long-term plan.

- aa3dc5c: Harden the native input-validation boundary and fix `lib64` cross-distro install
  breakage.

  - **Defence-in-depth validation in the native addon.** `nodeCount`,
    `resolution`, and `maxIterations` are now re-validated inside `binding.cc` in
    addition to the TS-side checks. Previously, a caller that bypassed the public
    API and resolved the native addon directly (e.g. via a deep `dist/native.js`
    import) could pass `nodeCount: 1.5` (silently floored), `nodeCount: -1`
    (coerced to `4294967295` and risking OOM), `maxIterations: 0` (skipping the
    optimisation loop and returning an un-improved partition), or
    `resolution: NaN` (propagating to `quality: NaN` and silently corrupting the
    score). All four are now rejected with a `RangeError` at the JS/C++
    boundary, matching the behaviour of the TS layer.
  - **Force `CMAKE_INSTALL_LIBDIR=lib`.** On multilib distributions (RHEL,
    Fedora, openSUSE, …) `GNUInstallDirs` defaults to `lib64`, but
    `binding.gyp` links against `<prefix>/lib/...` on every platform. The
    result was that `pnpm install` succeeded at the CMake step and then failed
    at `node-gyp rebuild` with a missing-library error. `scripts/build-deps.mjs`
    now pins the libdir to `lib` so the two sides agree, and surfaces a clear
    error if a stale `lib64/` is detected from a pre-fix build.
  - **Native boundary regression tests.** Added `test/native-validation.test.ts`
    which calls `native.leidenFromEdgeList`, `native.leidenFromCsr`, and the
    async variants directly to lock in the new rejections.

- 257986e: Close the remaining shipping-blockers from the production-readiness review.

  - **Native TypedArray element-type check.** `native.leidenFromEdgeList` and
    `native.leidenFromCsr` now reject any `TypedArray` whose element type is not
    exactly `Uint32Array` (for `sources` / `targets` / `offsets`) or
    `Float64Array` (for `weights`). Previously only `IsTypedArray()` was
    checked, so a deep-import caller could pass `new Uint8Array([0])` as
    `sources` and the unchecked `As<Napi::Uint32Array>()` cast aliased the
    buffer at the wrong stride, silently producing junk results. Both the
    sync and async entry points now throw `TypeError` on element-type
    mismatch.
  - **Reject negative weights.** `weights` values must now be **finite and
    non-negative**. Negative weights were previously accepted and flowed into
    `libleidenalg`, whose modularity / CPM implementations are defined over
    the non-negative reals — the "successful" return was meaningless.
    Checked on both the TS and native sides.
  - **Lock the public API with `exports`.** `package.json` now defines an
    `"exports"` map that exposes only the top-level entry (and
    `./package.json` for tooling). Deep imports such as
    `fast-leiden/dist/native.js` are now blocked at the Node loader level
    (`ERR_PACKAGE_PATH_NOT_EXPORTED`). The native binding is an internal
    implementation detail; consumers must go through the documented public
    API.
  - **Pin macOS deployment target.** `scripts/build-deps.mjs` now passes
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0` (matching `binding.gyp`'s
    `MACOSX_DEPLOYMENT_TARGET`) and `-DCMAKE_OSX_ARCHITECTURES=$(arch)` on
    macOS. This eliminates the "object file was built for newer macOS version
    than being linked" linker warning and prevents the silent SDK drift the
    warning was telegraphing.
  - **Build sentinel invalidates stale caches.** A `.build-sentinel.json` is
    written next to the installed libs capturing the host `platform`, `arch`,
    Node major, and macOS deployment target. On every `pnpm build:deps`, a
    mismatch wipes the install tree and triggers a full rebuild — a developer
    switching between arm64 / x86_64 or bumping Node majors no longer ends up
    with a stale vendor cache that links but fails at runtime.
  - **Tarball-install CI job.** A new `pack-install` matrix job (Linux +
    macOS × Node 22 / 24) runs `pnpm pack`, installs the tarball into a fresh
    project, smoke-tests the public API, and asserts that the deep import
    `fast-leiden/dist/native.js` is blocked. This catches `files` mis-globs,
    install-hook ordering bugs, and any future regression in the `exports`
    map.
  - **Documentation expanded.** README now covers the full API contract
    (TypedArray element types, weight constraints, self-loops, multi-edges,
    isolated nodes, community-id instability, resolution-only-for-CPM, async
    input-copy semantics), supported platforms, Node-API compatibility,
    CJS/ESM consumption, memory footprint, known limitations,
    troubleshooting, the pre-1.0 SemVer policy, and a GPL impact callout.
  - **Tests.** `native-validation` gains 11 cases covering wrong-element-type
    TypedArrays and negative weights. A new `boundary-cases` suite (9 cases)
    pins the public-API contract for empty graphs, isolated nodes,
    self-loops, multi-edges, weight=0 edges, and `nodeCount: 0`.

  Test count: 53 → 71, all passing.

All notable changes to this project will be documented in this file.

This file is maintained by [Changesets](https://github.com/changesets/changesets).
