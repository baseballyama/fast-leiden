import { createRequire } from "node:module";
import { join } from "node:path";

// We resolve the native addon through a CommonJS-style require so that the
// path stays stable regardless of how the consumer's bundler treats `.node`
// files. The compiled artifact lives in `build/Release/` after node-gyp runs.
const requireFromHere = createRequire(__filename);

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
}

const bindingPath = join(
  __dirname,
  "..",
  "build",
  "Release",
  "fast_leiden.node",
);

export const native: NativeBinding = requireFromHere(
  bindingPath,
) as NativeBinding;
