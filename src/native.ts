import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

// We hand the project root to `node-gyp-build`, which is the canonical
// resolver for native addons: it picks up a platform-specific prebuilt
// binary from `prebuilds/<platform>-<arch>/` if one was shipped in the
// tarball, and otherwise falls back to the source build under
// `build/Release/`. This keeps the require path stable across publish
// modes (prebuild vs. source) and across bundlers.
const requireFromHere = createRequire(__filename);
const projectRoot = resolve(dirname(__filename), "..");

export interface NativeLeidenInput {
  nodeCount: number;
  sources: Uint32Array;
  targets: Uint32Array;
  weights?: Float64Array;
  qualityFunction?: string;
  resolution?: number;
  maxIterations?: number;
  seed?: number;
  directed?: boolean;
}

export interface NativeLeidenCsrInput {
  nodeCount: number;
  offsets: Uint32Array;
  targets: Uint32Array;
  weights?: Float64Array;
  qualityFunction?: string;
  resolution?: number;
  maxIterations?: number;
  seed?: number;
  directed?: boolean;
}

export interface NativeLeidenResult {
  membership: Uint32Array;
  quality: number;
  iterations: number;
}

interface NativeBinding {
  version(): string;
  leidenFromEdgeList(input: NativeLeidenInput): NativeLeidenResult;
  leidenFromCsr(input: NativeLeidenCsrInput): NativeLeidenResult;
  leidenFromEdgeListAsync(input: NativeLeidenInput): Promise<NativeLeidenResult>;
  leidenFromCsrAsync(input: NativeLeidenCsrInput): Promise<NativeLeidenResult>;
}

const loadNative = requireFromHere("node-gyp-build") as (root: string) => NativeBinding;

export const native: NativeBinding = loadNative(projectRoot);
