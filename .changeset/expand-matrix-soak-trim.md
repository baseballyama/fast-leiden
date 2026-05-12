---
"fast-leiden": minor
---

Expand the prebuild matrix, add a weekly large-graph soak workflow, and
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
