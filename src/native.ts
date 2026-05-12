import { createRequire } from "node:module";
import { join } from "node:path";

// We resolve the native addon through a CommonJS-style require so that the
// path stays stable regardless of how the consumer's bundler treats `.node`
// files. The compiled artifact lives in `build/Release/` after node-gyp runs.
const requireFromHere = createRequire(__filename);

interface NativeBinding {
  version(): string;
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
