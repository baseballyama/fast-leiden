#!/usr/bin/env node
// Install hook for `npm install fast-leiden`.
//
// Tries the prebuilt binary first (via node-gyp-build's resolver). If a
// prebuild is available for this platform / arch / libc, we're done — no
// CMake, no node-gyp, no C++ toolchain required.
//
// If no prebuild matches, fall back to the full source build: build the
// vendored igraph + libleidenalg static libs via CMake, write the version
// header, then `node-gyp rebuild` the addon. This is the slow path; see
// README → "Install model and roadmap".

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");

const log = (...parts) => process.stdout.write(`fast-leiden: ${parts.join(" ")}\n`);
const die = (msg) => {
  process.stderr.write(`fast-leiden install: ${msg}\n`);
  process.exit(1);
};

const requireFromHere = createRequire(import.meta.url);

const tryUsePrebuild = () => {
  let nodeGypBuild;
  try {
    nodeGypBuild = requireFromHere("node-gyp-build");
  } catch {
    // node-gyp-build is a runtime dependency, so it should always be present
    // by the time the install script runs. If it isn't, fall through to the
    // source build path; the addon won't load at runtime but at least the
    // failure surfaces inside our build rather than at `require()` time.
    return false;
  }
  try {
    const found = nodeGypBuild.path(ROOT);
    log(`using prebuilt binary at ${found}`);
    return true;
  } catch {
    return false;
  }
};

const run = (cmd, args) => {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: ROOT,
    shell: process.platform === "win32",
  });
  if (res.error) die(`${cmd} failed to launch: ${res.error.message}`);
  if (res.status !== 0) {
    die(`${cmd} ${args.join(" ")} exited with status ${res.status}`);
  }
};

const buildFromSource = () => {
  log("no prebuilt binary for this platform; building from source (this can take several minutes)");
  run(process.execPath, [resolve(ROOT, "scripts/build-deps.mjs")]);
  run(process.execPath, [resolve(ROOT, "scripts/write-version-header.mjs")]);
  run("node-gyp", ["rebuild"]);
};

if (!tryUsePrebuild()) buildFromSource();
