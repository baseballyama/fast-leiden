# Security Policy

## Reporting a vulnerability

**Do not file a public GitHub issue for security bugs.**

Please report security issues privately via [GitHub's Private Vulnerability
Reporting](https://github.com/baseballyama/fast-leiden/security/advisories/new).
The maintainer will acknowledge within a reasonable timeframe and coordinate
a fix and disclosure.

Examples of issues in scope:

- Memory safety issues in the native addon (`native/binding.cc`) — segfaults,
  out-of-bounds reads / writes, use-after-free.
- Validation bypasses at the JS / C++ boundary that lead to native-side
  corruption.
- Vulnerabilities in the vendored upstream — `vendor/igraph`,
  `vendor/libleidenalg`. We will bump the submodule and re-release; please
  also report upstream.
- Supply-chain issues with the published npm tarball or the prebuilt
  binaries we ship.

Out of scope: theoretical denial-of-service via very large inputs (the
library is a CPU-bound algorithm — callers are expected to bound input size
themselves), and concerns about the GPL-3.0-or-later license itself.

## Supported versions

We patch the most recent minor release line of the current major.
Concretely: the latest `X.Y.x` of the latest `X.0.0` series. Older
majors are not supported once a new major ships; backporting fixes
across majors is best-effort and depends on the severity of the issue.

Security fixes are released as **patch** versions whenever possible,
even when the underlying change would otherwise warrant a minor
(e.g., a vendor submodule bump that fixes a CVE).
