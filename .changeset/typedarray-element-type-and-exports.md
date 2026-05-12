---
"fast-leiden": patch
---

Close the remaining shipping-blockers from the production-readiness review.

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
