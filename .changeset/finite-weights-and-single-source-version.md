---
"fast-leiden": patch
---

Reject non-finite `weights` values, unify `version()` with `package.json`, and add a dist smoke test.

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
