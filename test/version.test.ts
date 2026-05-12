import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";

describe("version()", () => {
  it("returns a non-empty string from the native addon", () => {
    const v = version();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });

  it("looks like a semver string", () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
