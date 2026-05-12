#!/usr/bin/env node
// Cross-platform `rm -rf` for the project's build outputs. Replaces the
// `rimraf` dev dependency now that Node provides fs.rmSync natively.

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");

const targets = ["dist", "build", "vendor/build-deps"];

for (const t of targets) {
  rmSync(resolve(ROOT, t), { recursive: true, force: true });
  process.stdout.write(`clean: removed ${t}\n`);
}
