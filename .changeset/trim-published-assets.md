---
"fast-leiden": patch
---

Trim unused upstream assets from the published tarball: `vendor/igraph/tools/` (dev-only Python scripts) and the Stimulus binding-generator inputs `vendor/igraph/interfaces/{functions,types}.yaml`. None of these are referenced by the CMake build path we use, so removing them shrinks `npm install` without affecting the source-build fallback.
