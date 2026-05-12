---
"fast-leiden": patch
---

Harden the native input-validation boundary and fix `lib64` cross-distro install
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
