// Tiny benchmark harness. Once the native Leiden path is wired up, this
// script will compare fast-leiden against the Python `igraph + leidenalg`
// baseline on a few representative graph sizes.
//
// For now it just prints the addon version so we can confirm the build
// pipeline end-to-end without a real benchmark target.

import { version } from "../src/index.js";

const main = (): void => {
  // eslint-disable-next-line no-console
  console.log(`fast-leiden native addon version: ${version()}`);
  // eslint-disable-next-line no-console
  console.log("Benchmark suite is not implemented yet (roadmap step 8).");
};

main();
