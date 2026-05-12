#!/usr/bin/env node
// Build a prebuilt binary for the current host.
//
// Runs the full vendor-dep build (CMake static libs) and then invokes
// `prebuildify --napi --strip` to package the resulting .node file under
// `prebuilds/<platform>-<arch>/`. The CI workflow at
// `.github/workflows/prebuilds.yml` runs this on every supported runner and
// uploads the result as an artifact; a release job then assembles the
// platform-specific outputs into a single npm tarball.
//
// `--napi` tells prebuildify that the addon is N-API based (one binary per
// platform/arch, not per Node major). `--strip` removes symbols on Unix
// (Windows is a no-op); the warning we want to avoid is publishing 100 MB
// of debug info to npm.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");

const log = (...parts) => process.stdout.write(`prebuild: ${parts.join(" ")}\n`);
const die = (msg) => {
  process.stderr.write(`prebuild: ${msg}\n`);
  process.exit(1);
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

log("building vendor static libs");
run(process.execPath, [resolve(ROOT, "scripts/build-deps.mjs")]);
log("writing native version header");
run(process.execPath, [resolve(ROOT, "scripts/write-version-header.mjs")]);

// prebuildify resolves node-gyp internally. We pass --napi so the resulting
// binary is published as `node.napi.node` (single file per platform/arch),
// and --strip so we don't publish debug symbols. Call the bin.js directly
// via Node so we don't depend on a particular package manager's shim layout
// (npx / pnpm exec / yarn run all differ slightly).
//
// `--tag-libc` is added on Linux glibc / musl builds (driven by the env
// var the CI workflow sets) so glibc and musl binaries can coexist in the
// same `prebuilds/linux-<arch>/` directory. node-gyp-build picks the one
// matching the consumer's libc at runtime.
const prebuildArgs = [resolve(ROOT, "node_modules/prebuildify/bin.js"), "--napi", "--strip"];
const libc = process.env.PREBUILDIFY_LIBC ?? "";
if (libc) {
  prebuildArgs.push("--tag-libc");
  log(`tagging libc as ${libc}`);
}
log("running prebuildify");
run(process.execPath, prebuildArgs);
