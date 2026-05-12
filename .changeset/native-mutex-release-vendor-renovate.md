---
"fast-leiden": minor
---

Production-readiness pass: native serialization, hardened release flow,
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
  table between the `<!-- vendor-versions:start -->` /  `:end -->`
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
