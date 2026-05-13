---
"fast-leiden": patch
---

Slim the published tarball down to what Tier 1 consumers actually need: `dist/`, `prebuilds/`, `LICENSE`, `README.md`, `SECURITY.md`. The vendored upstream sources (`vendor/`), the `native/` C++ source, `binding.gyp`, and the `scripts/` helpers are no longer shipped, and the `install` lifecycle hook is removed — `node-gyp-build` resolves the prebuilt addon at `require()` time directly.

Unpacked tarball size drops from ~16 MB to ~500 kB (single-prebuild) / ~2.6 MB (full matrix). Tier 1 platforms (`linux-{x64,arm64}` glibc/musl, `darwin-arm64`, `win32-x64`) are unaffected. Tier 2 platforms that previously relied on the install-time source-build fallback (notably `darwin-x64` Intel Mac) now need to install from a `--recursive` git clone and run `pnpm build`; the README has been updated accordingly.
