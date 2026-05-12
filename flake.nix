{
  description = "fast-leiden — Leiden community detection for Node.js";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Python with the comparison baseline pre-installed, so `pnpm bench`
        # finds it without anyone needing to set up a venv.
        pythonForBench = pkgs.python3.withPackages (ps: with ps; [
          igraph
          leidenalg
        ]);
      in
      {
        devShells.default = pkgs.mkShell {
          name = "fast-leiden";

          packages = with pkgs; [
            # Runtime / package manager. corepack is shipped with nodejs and
            # honours the `packageManager` field in package.json, so pnpm is
            # always the version this repo pins to.
            nodejs_24

            # Native build dependencies. libleidenalg requires CMake >= 3.23,
            # and node-gyp shells out to make / msbuild under the hood.
            cmake
            gnumake
            pkg-config

            # Optional but useful.
            git
            jq

            pythonForBench
          ];

          shellHook = ''
            corepack enable pnpm 2>/dev/null || true

            echo ""
            echo "fast-leiden dev shell"
            echo "  node:   $(node --version)"
            echo "  pnpm:   $(pnpm --version 2>/dev/null || echo 'run: corepack prepare pnpm@<version> --activate')"
            echo "  cmake:  $(cmake --version | head -n1 | awk '{print $3}')"
            echo "  python: $(python3 --version | awk '{print $2}')"
            echo ""
          '';
        };
      });
}
