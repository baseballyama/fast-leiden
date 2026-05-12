#!/usr/bin/env bash
# Build igraph and libleidenalg as static libraries into vendor/build-deps/install.
#
# node-gyp does not natively understand CMake, so we run CMake here once and
# then point binding.gyp at the resulting headers + .a files. Re-running this
# script after `pnpm install --recursive` (or after pulling new commits in the
# submodules) is enough to keep the native addon up to date.

set -euo pipefail

cd "$(dirname "$0")/.."

ROOT="$(pwd)"
VENDOR="$ROOT/vendor"
BUILD_DIR="$VENDOR/build-deps"
INSTALL_DIR="$BUILD_DIR/install"

JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

mkdir -p "$BUILD_DIR" "$INSTALL_DIR"

if [[ ! -f "$VENDOR/igraph/CMakeLists.txt" || ! -f "$VENDOR/libleidenalg/CMakeLists.txt" ]]; then
  echo "vendored submodules are missing. Run:" >&2
  echo "  git submodule update --init --recursive" >&2
  exit 1
fi

# --- igraph ---------------------------------------------------------------
#
# Build as a static library so the resulting node addon doesn't have a
# runtime dependency on a system-installed shared object. The default
# upstream config pulls in GraphML/libxml2 — disabled here to keep the
# dependency surface minimal.

IGRAPH_BUILD="$BUILD_DIR/igraph"
if [[ ! -f "$INSTALL_DIR/lib/libigraph.a" && ! -f "$INSTALL_DIR/lib64/libigraph.a" ]]; then
  echo "==> Configuring igraph"
  cmake -S "$VENDOR/igraph" -B "$IGRAPH_BUILD" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DBUILD_SHARED_LIBS=OFF \
    -DIGRAPH_GRAPHML_SUPPORT=OFF \
    -DIGRAPH_WARNINGS_AS_ERRORS=OFF \
    -DIGRAPH_ENABLE_TLS=OFF \
    -DIGRAPH_USE_INTERNAL_BLAS=ON \
    -DIGRAPH_USE_INTERNAL_LAPACK=ON \
    -DIGRAPH_USE_INTERNAL_ARPACK=ON \
    -DIGRAPH_USE_INTERNAL_GLPK=ON \
    -DIGRAPH_USE_INTERNAL_GMP=ON \
    -DIGRAPH_USE_INTERNAL_PLFIT=ON \
    -DIGRAPH_GLPK_SUPPORT=OFF \
    -DIGRAPH_OPENMP_SUPPORT=OFF
  echo "==> Building igraph (this can take several minutes)"
  cmake --build "$IGRAPH_BUILD" --target install -j "$JOBS"
else
  echo "==> igraph already installed in $INSTALL_DIR"
fi

# --- libleidenalg ---------------------------------------------------------

LLA_BUILD="$BUILD_DIR/libleidenalg"
if [[ ! -f "$INSTALL_DIR/lib/libleidenalg.a" && ! -f "$INSTALL_DIR/lib64/libleidenalg.a" ]]; then
  echo "==> Configuring libleidenalg"
  cmake -S "$VENDOR/libleidenalg" -B "$LLA_BUILD" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DCMAKE_PREFIX_PATH="$INSTALL_DIR" \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DBUILD_SHARED_LIBS=OFF
  echo "==> Building libleidenalg"
  cmake --build "$LLA_BUILD" --target install -j "$JOBS"
else
  echo "==> libleidenalg already installed in $INSTALL_DIR"
fi

echo "==> Done. Headers: $INSTALL_DIR/include  Libs: $INSTALL_DIR/lib(64)"
