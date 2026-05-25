---
"fast-leiden": minor
---

Bump vendored upstream `libleidenalg` from `0.11.1` to `0.13.0`.

Behavior change to be aware of: the upstream default for the refinement
phase changed from "consider all neighbour communities" to "consider a
random neighbour community" (libleidenalg commit `f5dc3b6`). This aligns
the implementation with the original Leiden paper. The shape of the
public API is unchanged, but **partition output may shift between this
release and the previous one for the same input and seed**. Community
ids were never stable across `libleidenalg` versions
(see "Known limitations" in the README); this bump is a concrete instance
of that.
