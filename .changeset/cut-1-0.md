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
- **Prebuild + publish jobs are gated at the job level.** The earlier
  step-level gating left every matrix entry spinning up a runner on
  Release-PR runs, which broke on the Alpine `node:22-alpine`
  container (no `bash`) and on the retired `macos-13` runner (the
  `darwin-x64` row sat `queued` and, with `cancel-in-progress: false`,
  blocked every later Release run from updating the Version Packages
  PR). The new gating shows "Skipped" rows on Release-PR runs and
  spins up real runners only on the publish path.
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
