// Smoke test for the published build output.
//
// All other tests import from `../src/index.js`, which only exercises the
// TypeScript source. This file imports from the compiled `../dist/index.js`
// instead, so CI catches drift between source and the artifact that ships to
// npm (broken `main` resolution, missing exports, type-vs-runtime mismatches,
// stale `dist/` after a refactor).
//
// The file is skipped when `dist/` is absent so contributors can run
// `pnpm test` without a prior `pnpm build:ts`.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distEntry = resolve(root, "dist", "index.js");
const distAvailable = existsSync(distEntry);

const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere("../package.json") as {
  version: string;
  main: string;
};

const suite = distAvailable ? describe : describe.skip;

suite("dist smoke (built artifact)", () => {
  it("package.json#main points at an existing file", () => {
    expect(existsSync(resolve(root, pkg.main))).toBe(true);
  });

  it("loads the built entry and exports the public API", async () => {
    const mod = (await import(distEntry)) as typeof import("../src/index.js");
    expect(typeof mod.version).toBe("function");
    expect(typeof mod.leiden).toBe("function");
    expect(typeof mod.leidenFromCsr).toBe("function");
    expect(typeof mod.leidenAsync).toBe("function");
    expect(typeof mod.leidenFromCsrAsync).toBe("function");
  });

  it("dist version() matches package.json", async () => {
    const mod = (await import(distEntry)) as typeof import("../src/index.js");
    expect(mod.version()).toBe(pkg.version);
  });

  it("runs Leiden through the built entry", async () => {
    const mod = (await import(distEntry)) as typeof import("../src/index.js");
    const result = mod.leiden({
      nodeCount: 6,
      sources: new Uint32Array([0, 1, 0, 3, 4, 3, 2]),
      targets: new Uint32Array([1, 2, 2, 4, 5, 5, 5]),
      seed: 42,
    });
    expect(result.membership.length).toBe(6);
    expect(result.membership[0]).toBe(result.membership[1]);
    expect(result.membership[3]).toBe(result.membership[4]);
    expect(result.membership[0]).not.toBe(result.membership[3]);
  });
});
