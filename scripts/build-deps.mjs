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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// igraph + libleidenalg detect their version via `git describe`. That breaks
// when the submodules ship inside an npm tarball with no .git directory, so
// we hand each CMake project a static VERSION file before configuring.
// Update these when bumping submodule pins.
const IGRAPH_VERSION_FALLBACK = "1.0.1";
const LIBLEIDENALG_VERSION_FALLBACK = "0.12.0";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const VENDOR = join(ROOT, "vendor");
const BUILD_DIR = join(VENDOR, "build-deps");
const INSTALL_DIR = join(BUILD_DIR, "install");
const IS_WIN = platform() === "win32";
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

const findInstalledLib = (basename) => {
  for (const subdir of ["lib", "lib64"]) {
    const candidate = join(INSTALL_DIR, subdir, basename);
    if (existsSync(candidate)) return candidate;
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

// Write the VERSION file each upstream CMake looks for first. When git is
// available inside the submodule, prefer `git describe --tags` so the version
// matches what's actually checked out; otherwise fall back to the constants
// at the top of this file.
const writeVersionFile = (submodule, filename, fallback) => {
  const dir = join(VENDOR, submodule);
  const dest = join(dir, filename);
  if (existsSync(dest)) return;

  let version = fallback;
  const git = spawnSync("git", ["describe", "--tags", "--always"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (git.status === 0) {
    const candidate = git.stdout.trim();
    if (candidate) version = candidate;
  }
  writeFileSync(dest, `${version}\n`);
  log(`==> Wrote ${submodule}/${filename}: ${version}`);
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
    `-DCMAKE_POSITION_INDEPENDENT_CODE=ON`,
    `-DBUILD_SHARED_LIBS=OFF`,
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
  mkdirSync(INSTALL_DIR, { recursive: true });
  buildIgraph();
  buildLibleidenalg();
  log(`==> Done. Headers: ${join(INSTALL_DIR, "include")}`);
  log(`==> Libs:    ${join(INSTALL_DIR, "lib")} (or lib64)`);
};

main();
