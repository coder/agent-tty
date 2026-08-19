{
  description = "Nix package and development shell for agent-tty";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
    forAllSystems = nixpkgs.lib.genAttrs systems;
  in {
    packages = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
      lib = pkgs.lib;
      nodejs = pkgs.nodejs_26;

      dependencySource = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./package.json
          ./aube-lock.yaml
          ./pnpm-workspace.yaml
        ];
      };

      packageSource = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./package.json
          ./aube-lock.yaml
          ./pnpm-workspace.yaml
          ./tsconfig.json
          ./tsconfig.build.json
          ./src
          ./scripts
          ./skills
          ./skill-data
        ];
      };

      # Aube's lockfile contains integrity hashes for every package, while this
      # fixed-output derivation pins the complete downloaded cache. The package
      # derivation below must then install with --offline.
      dependencyCache = pkgs.stdenvNoCC.mkDerivation {
        pname = "agent-tty-aube-cache";
        version = "0.5.0";
        src = dependencySource;

        nativeBuildInputs = [
          pkgs.aube
          pkgs.cacert
        ];

        dontConfigure = true;
        dontFixup = true;

        buildPhase = ''
          runHook preBuild

          # Use Nixpkgs' pinned Aube. Package-manager self-switching would make
          # the fetched tool another undeclared dependency of the build.
          substituteInPlace package.json \
            --replace-fail '  "packageManager": "aube@1.2.0",' ""

          export HOME="$TMPDIR/home"
          export XDG_CACHE_HOME="$TMPDIR/cache"
          export XDG_DATA_HOME="$TMPDIR/data"
          mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"

          aube fetch --frozen-lockfile --reporter append-only

          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/cache" "$out/data"
          cp -R "$XDG_CACHE_HOME"/. "$out/cache"/
          cp -R "$XDG_DATA_HOME"/. "$out/data"/
          runHook postInstall
        '';

        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-U5oksqBtoQTDwVKwEXjgc9z3WRaMv7MVPyeK3/195oc=";
      };

      agent-tty = pkgs.stdenvNoCC.mkDerivation {
        pname = "agent-tty";
        version = "0.5.0";
        src = packageSource;

        nativeBuildInputs = [
          pkgs.aube
          nodejs
          pkgs.python3
          pkgs.stdenv.cc
          pkgs.gnumake
          pkgs.pkg-config
          pkgs.node-gyp
          pkgs.makeWrapper
        ];

        dontConfigure = true;

        buildPhase = ''
          runHook preBuild

          substituteInPlace package.json \
            --replace-fail '  "packageManager": "aube@1.2.0",' ""

          export HOME="$TMPDIR/home"
          export XDG_CACHE_HOME="$TMPDIR/cache"
          export XDG_DATA_HOME="$TMPDIR/data"
          mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
          cp -R ${dependencyCache}/cache/. "$XDG_CACHE_HOME"/
          cp -R ${dependencyCache}/data/. "$XDG_DATA_HOME"/
          chmod -R u+w "$XDG_CACHE_HOME" "$XDG_DATA_HOME"

          aube install \
            --offline \
            --frozen-lockfile \
            --ignore-scripts \
            --disable-global-virtual-store \
            --package-import-method copy \
            --reporter append-only

          # node-pty has no Linux prebuild in the locked package. Build it with
          # Nixpkgs' node-gyp so Aube never bootstraps a tool from the network.
          (
            cd node_modules/node-pty
            node-gyp rebuild
          )
          npm run build

          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          app="$out/lib/agent-tty"
          production="$TMPDIR/production"
          mkdir -p "$app" "$out/bin"

          # Build tools are devDependencies, so compile first and then create a
          # fresh production graph. Aube's in-place prune currently leaves
          # dangling virtual-store links behind.
          mkdir -p "$production"
          cp package.json aube-lock.yaml pnpm-workspace.yaml "$production"/
          (
            cd "$production"
            aube install \
              --prod \
              --offline \
              --frozen-lockfile \
              --ignore-scripts \
              --disable-global-virtual-store \
              --package-import-method copy \
              --reporter append-only

            cd node_modules/node-pty
            node-gyp rebuild
          )

          cp -R dist package.json skills skill-data "$app"/
          cp -R "$production/node_modules" "$app"/

          makeWrapper ${nodejs}/bin/node "$out/bin/agent-tty" \
            --add-flags "$app/dist/cli/main.js"

          runHook postInstall
        '';

        meta = {
          description = "Drive, inspect, and record terminal sessions from the CLI";
          homepage = "https://github.com/coder/agent-tty";
          license = lib.licenses.asl20;
          mainProgram = "agent-tty";
          platforms = systems;
        };
      };
    in {
      default = agent-tty;
      inherit agent-tty;
    });

    checks = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
      package = self.packages.${system}.default;
    in {
      inherit package;

      smoke =
        pkgs.runCommand "agent-tty-smoke" {
          nativeBuildInputs = [
            package
            pkgs.jq
          ];
        } ''
            export HOME="$TMPDIR/home"
          mkdir -p "$HOME"

          agent-tty version --json > version.json
          doctor_exit=0
          agent-tty --home "$TMPDIR/agent-tty-home" doctor --json > doctor.json || doctor_exit=$?
          printf '%s\n' "$doctor_exit" > doctor-exit-status
          jq -e '.result.checks.environment[] | select(.name == "pty-spawn" and .status == "pass")' doctor.json

          mkdir -p "$out"
          cp version.json doctor.json doctor-exit-status "$out"/
        '';
    });

    devShells = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
    in {
      default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_26
          pkgs.aube
          pkgs.python3
          pkgs.stdenv.cc
          pkgs.gnumake
          pkgs.pkg-config
          pkgs.git
          pkgs.cacert
        ];
      };
    });

    formatter = forAllSystems (system: (import nixpkgs {inherit system;}).alejandra);
  };
}
