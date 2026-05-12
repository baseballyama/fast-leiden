---
"fast-leiden": minor
---

**ESM-only.** `fast-leiden` is now shipped exclusively as an ES module.

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
