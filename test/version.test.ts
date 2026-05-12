import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";
import { native } from "../src/native.js";

// Read package.json via createRequire so the test doesn't depend on
// resolveJsonModule and rootDir layout.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

describe("version()", () => {
  it("returns a non-empty semver-like string", () => {
    const v = version();
    expect(typeof v).toBe("string");
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  // Anchors version() to package.json so a release bump can't silently
  // ship a mismatched native addon.
  it("exactly matches package.json#version", () => {
    expect(version()).toBe(pkg.version);
  });

  // The native side bakes in the same string at compile time via the generated
  // header. If the addon was rebuilt against a stale header (or someone edited
  // version_generated.h by hand), this will catch the drift.
  it("agrees with the native addon kAddonVersion", () => {
    expect(native.version()).toBe(pkg.version);
  });
});
