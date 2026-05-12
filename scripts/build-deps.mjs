#!/usr/bin/env node
// Cross-platform builder for the C/C++ deps fast-leiden links against.
//
// node-gyp doesn't speak CMake natively, so this script runs CMake once to
// build igraph + libleidenalg as static libraries into vendor/build-deps/install.
// binding.gyp then points at the resulting headers and `.a` / `.lib`.
//
// Re-run this after pulling submodule updates. Skips work if both libraries
// are already installed.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// igraph + libleidenalg detect their version via `git describe`. That breaks
// when the submodules ship inside an npm tarball with no .git directory, so
// we hand each CMake project a static VERSION file before configuring.
// Update these when bumping submodule pins.
const IGRAPH_VERSION_FALLBACK = "1.0.1";
const LIBLEIDENALG_VERSION_FALLBACK = "0.12.0";

// binding.gyp pins MACOSX_DEPLOYMENT_TARGET to 11.0; the CMake build of the
// vendored deps must match, otherwise the final `ld` step emits "built for
// newer macOS version than being linked" warnings and the result is not
// reproducible across machines with different SDKs. Bump these in lock-step
// with binding.gyp.
const MACOS_DEPLOYMENT_TARGET = "11.0";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const VENDOR = join(ROOT, "vendor");
const BUILD_DIR = join(VENDOR, "build-deps");
const INSTALL_DIR = join(BUILD_DIR, "install");
const SENTINEL_PATH = join(INSTALL_DIR, ".build-sentinel.json");
const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";
// On Unix the library files come out as `lib<target>.a`; on Windows MSVC
// produces `<target>.lib` (no `lib` prefix). The libleidenalg CMake target
// is named `libleidenalg` so the file is `liblibleidenalg.a` on Unix and
// `libleidenalg.lib` on Windows.
const IGRAPH_LIB = IS_WIN ? "igraph.lib" : "libigraph.a";
const LIBLEIDENALG_LIB = IS_WIN ? "libleidenalg.lib" : "liblibleidenalg.a";

const log = (...parts) => {
  // Use process.stdout so we don't depend on console being unmocked.
  process.stdout.write(`${parts.join(" ")}\n`);
};

const die = (msg) => {
  process.stderr.write(`build-deps: ${msg}\n`);
  process.exit(1);
};

const run = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error) die(`${cmd} failed to launch: ${res.error.message}`);
  if (res.status !== 0) {
    die(`${cmd} ${args.join(" ")} exited with status ${res.status}`);
  }
};

// The vendored static libs depend on the host platform, the target arch, and
// (on macOS) the SDK / deployment target. The presence of the `.a` file alone
// can't tell us whether it matches the *current* environment — a developer who
// switched machines, upgraded macOS, or moved between arm64 and x86_64 ends
// up with a stale install tree that links but then crashes or fails to load.
//
// Capture the relevant axes in a sentinel JSON file written next to the libs.
// On every run we compare the current axes against the recorded ones and wipe
// the install tree on mismatch so the rebuild is forced.
const currentBuildAxes = () => ({
  // schemaVersion bumps invalidate every previously cached install tree on
  // the next run. Bump this whenever an axis the install tree depends on
  // changes (CRT model, ABI flags, compile defines that change linkage,
  // etc.) and the change isn't already captured by one of the existing
  // axes below.
  schemaVersion: 2,
  platform: platform(),
  arch: arch(),
  nodeMajor: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10),
  macosDeploymentTarget: IS_MAC ? MACOS_DEPLOYMENT_TARGET : null,
});

const readSentinel = () => {
  if (!existsSync(SENTINEL_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SENTINEL_PATH, "utf8"));
  } catch {
    return null;
  }
};

const writeSentinel = () => {
  writeFileSync(SENTINEL_PATH, `${JSON.stringify(currentBuildAxes(), null, 2)}\n`);
};

const axesEqual = (a, b) =>
  a !== null &&
  b !== null &&
  a.schemaVersion === b.schemaVersion &&
  a.platform === b.platform &&
  a.arch === b.arch &&
  a.nodeMajor === b.nodeMajor &&
  a.macosDeploymentTarget === b.macosDeploymentTarget;

const invalidateIfStale = () => {
  const recorded = readSentinel();
  const current = currentBuildAxes();
  if (recorded === null) return;
  if (axesEqual(recorded, current)) return;
  log(
    `==> Build sentinel mismatch (was ${JSON.stringify(recorded)}, now ` +
      `${JSON.stringify(current)}); wiping ${INSTALL_DIR} to force a rebuild.`,
  );
  rmSync(INSTALL_DIR, { recursive: true, force: true });
};

// binding.gyp links against `<INSTALL_DIR>/lib/...` on every platform, so the
// CMake configure step below pins CMAKE_INSTALL_LIBDIR to `lib`. Anything in
// `lib64/` would be a stale leftover from a build that predates that pin —
// surface it instead of silently letting node-gyp rebuild fail.
const findInstalledLib = (basename) => {
  const expected = join(INSTALL_DIR, "lib", basename);
  if (existsSync(expected)) return expected;
  const legacy = join(INSTALL_DIR, "lib64", basename);
  if (existsSync(legacy)) {
    die(
      `Found ${legacy} but binding.gyp links against ${expected}. ` +
        `Run \`pnpm clean\` (or remove vendor/build-deps) and rebuild.`,
    );
  }
  return null;
};

const ensureSubmodules = () => {
  for (const name of ["igraph", "libleidenalg"]) {
    if (!existsSync(join(VENDOR, name, "CMakeLists.txt"))) {
      die(`vendor/${name} is missing. Run:\n  git submodule update --init --recursive`);
    }
  }
};

// Make sure each upstream CMake project can resolve a usable version. Both
// vendored projects' CMake first tries `${SOURCE_DIR}/VERSION` (or
// `IGRAPH_VERSION`), then falls back to `git_describe()`, then to a packaging
// metadata file. We have three layered paths:
//
//   1. Source checkout with tags reachable from the pinned commit (the
//      typical local dev case): upstream's CMake `git_describe()` resolves
//      the version cleanly on its own, so we DO NOTHING. Writing a VERSION
//      file here would dirty the submodule (`?? VERSION` in `git status`)
//      for no reason; the build is fully reproducible without it.
//   2. CI source checkout with shallow submodule fetch (no tags): `git
//      describe` returns a bare SHA or fails, which CMake's
//      `project(VERSION ...)` would reject. We write a fallback VERSION file
//      so configure succeeds. The submodule is in a checkout-only sandbox in
//      CI, so dirtying it is fine.
//   3. Tarball install (no `.git` directory at all): same as (2) — we write
//      the fallback VERSION file.
//
// We MUST NOT accept a bare SHA: CMake's `project(VERSION ...)` rejects
// anything that isn't `MAJOR[.MINOR[.PATCH[.TWEAK]]]`, all digits. Validate
// the candidate against the CMake-accepted shape before deciding the
// upstream CMake will handle versioning on its own.
const CMAKE_VERSION_RE = /^\d+(?:\.\d+){0,3}$/;

const writeVersionFile = (submodule, filename, fallback) => {
  const dir = join(VENDOR, submodule);
  const dest = join(dir, filename);
  if (existsSync(dest)) return;

  // Some upstreams tag as `v1.2.3`, some as `1.2.3` — strip the leading `v`
  // so the regex sees a clean digit-only string. Also strip the
  // `-N-gSHA` suffix `git describe` adds when HEAD is past the last tag;
  // upstream CMake strips it the same way before passing to `project(...)`.
  const git = spawnSync("git", ["describe", "--tags"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (git.status === 0) {
    const raw = git.stdout.trim();
    const candidate = raw.replace(/^v/, "").replace(/-\d+-g[0-9a-f]+$/i, "");
    if (CMAKE_VERSION_RE.test(candidate)) {
      log(`==> ${submodule}: git describe resolves to ${candidate}; skipping ${filename} write`);
      return;
    }
  }

  // git couldn't give us a CMake-compatible version. Write the fallback so
  // configure doesn't fail. This is the shallow-CI / tarball-install path.
  writeFileSync(dest, `${fallback}\n`);
  log(`==> Wrote ${submodule}/${filename}: ${fallback} (fallback; git describe unavailable)`);
};

const writeVendorVersionFiles = () => {
  writeVersionFile("igraph", "IGRAPH_VERSION", IGRAPH_VERSION_FALLBACK);
  writeVersionFile("libleidenalg", "VERSION", LIBLEIDENALG_VERSION_FALLBACK);
};

const jobs = () => String(availableParallelism?.() ?? 4);

const cmakeConfigure = (sourceDir, buildDir, extra) => {
  mkdirSync(buildDir, { recursive: true });
  const args = [
    "-S",
    sourceDir,
    "-B",
    buildDir,
    `-DCMAKE_BUILD_TYPE=Release`,
    `-DCMAKE_INSTALL_PREFIX=${INSTALL_DIR}`,
    // GNUInstallDirs defaults to `lib64` on multilib distributions (RHEL,
    // Fedora, openSUSE …). binding.gyp links against `<prefix>/lib/...` on
    // every platform, so force the libdir to `lib` to keep the two in sync.
    // Without this pin, `pnpm install` succeeds at the CMake step but fails
    // at `node-gyp rebuild` on those distros.
    `-DCMAKE_INSTALL_LIBDIR=lib`,
    `-DCMAKE_POSITION_INDEPENDENT_CODE=ON`,
    `-DBUILD_SHARED_LIBS=OFF`,
    // Match binding.gyp on macOS so the static `.a` files and the final
    // `.node` are linked against the same SDK and the same deployment target.
    // Without these, the linker warns "object file was built for newer macOS
    // version than being linked" — a smell that production hits as a real
    // failure when the SDKs drift further apart.
    ...(IS_MAC
      ? [
          `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOS_DEPLOYMENT_TARGET}`,
          `-DCMAKE_OSX_ARCHITECTURES=${arch()}`,
        ]
      : []),
    // Pin the MSVC CRT to `/MT` (static release runtime) so igraph +
    // libleidenalg's static `.lib`s match the `/MT` that node-gyp uses for
    // `binding.obj`. CMake (3.15+) honours this only when the active
    // generator is MSVC, so it's a no-op on Linux/macOS, but explicit is
    // safer than relying on CMake's default. Without this, the Windows
    // build fails with LNK2038 `RuntimeLibrary` mismatches and a cascade of
    // `__imp_*` unresolved-externals from the dynamic CRT being half-linked.
    `-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`,
    ...extra,
  ];
  run("cmake", args);
};

const cmakeBuildInstall = (buildDir) => {
  run("cmake", ["--build", buildDir, "--target", "install", "--config", "Release", "-j", jobs()]);
};

const buildIgraph = () => {
  if (findInstalledLib(IGRAPH_LIB)) {
    log(`==> igraph already installed in ${INSTALL_DIR}`);
    return;
  }
  log("==> Configuring igraph");
  cmakeConfigure(join(VENDOR, "igraph"), join(BUILD_DIR, "igraph"), [
    "-DIGRAPH_GRAPHML_SUPPORT=OFF",
    "-DIGRAPH_WARNINGS_AS_ERRORS=OFF",
    "-DIGRAPH_ENABLE_TLS=OFF",
    "-DIGRAPH_USE_INTERNAL_BLAS=ON",
    "-DIGRAPH_USE_INTERNAL_LAPACK=ON",
    "-DIGRAPH_USE_INTERNAL_ARPACK=ON",
    "-DIGRAPH_USE_INTERNAL_GLPK=ON",
    "-DIGRAPH_USE_INTERNAL_GMP=ON",
    "-DIGRAPH_USE_INTERNAL_PLFIT=ON",
    "-DIGRAPH_GLPK_SUPPORT=OFF",
    "-DIGRAPH_OPENMP_SUPPORT=OFF",
    // We never run igraph's own test suite; disabling BUILD_TESTING
    // (which CTest turns on by default) skips the add_subdirectory(tests)
    // step that would otherwise need the tests/ tree we strip out of
    // the published tarball.
    "-DBUILD_TESTING=OFF",
  ]);
  log("==> Building igraph (this can take several minutes)");
  cmakeBuildInstall(join(BUILD_DIR, "igraph"));
};

const buildLibleidenalg = () => {
  if (findInstalledLib(LIBLEIDENALG_LIB)) {
    log(`==> libleidenalg already installed in ${INSTALL_DIR}`);
    return;
  }
  log("==> Configuring libleidenalg");
  cmakeConfigure(join(VENDOR, "libleidenalg"), join(BUILD_DIR, "libleidenalg"), [
    `-DCMAKE_PREFIX_PATH=${INSTALL_DIR}`,
  ]);
  log("==> Building libleidenalg");
  cmakeBuildInstall(join(BUILD_DIR, "libleidenalg"));
};

const main = () => {
  ensureSubmodules();
  writeVendorVersionFiles();
  invalidateIfStale();
  mkdirSync(INSTALL_DIR, { recursive: true });
  buildIgraph();
  buildLibleidenalg();
  writeSentinel();
  log(`==> Done. Headers: ${join(INSTALL_DIR, "include")}`);
  log(`==> Libs:    ${join(INSTALL_DIR, "lib")}`);
};

main();
