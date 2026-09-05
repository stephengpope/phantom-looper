#!/usr/bin/env bash
# Build the phantom-cli release tarballs — one per platform, each fully
# self-contained: the esbuild bundle, the voice sidecar's files, the server
# install script the setup wizard pipes over ssh, and a PINNED Node runtime.
# Nothing is required on the machine that unpacks one — that is the whole
# promise of `curl | sh`, and the same pattern the app already trusts for uv
# (voice.ts downloads a pinned release, checksum-verified).
#
#   ./scripts/build-cli.sh                 all four platforms, version from package.json
#   ./scripts/build-cli.sh v0.2.0          stamp a release version
#   PLATFORMS="darwin-arm64" ./scripts/build-cli.sh   just one (local testing)
#
# Output: dist-cli/phantom-cli-<os>-<arch>.tar.gz + checksums.txt. Asset names
# carry NO version — GitHub's releases/latest/download/<name> needs a stable
# name; the release itself is the version, and VERSION inside the tarball says
# which one landed on disk.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION="${NODE_VERSION:-22.22.0}"
VERSION="${1:-$(node -p "require('./package.json').version")}"
VERSION="${VERSION#v}"
PLATFORMS="${PLATFORMS:-darwin-arm64 darwin-x64 linux-x64 linux-arm64}"
OUT=dist-cli
CACHE="$OUT/node-cache"

echo "→ phantom-cli $VERSION on node $NODE_VERSION"
rm -rf "$OUT/stage" "$OUT"/phantom-cli-*.tar.gz "$OUT/checksums.txt"
mkdir -p "$OUT" "$CACHE"

# ── the bundle: platform-independent, built once ────────────────────────────
# react-devtools-core: Ink only imports it when DEV=true, but single-file
# bundling hoists the external import into a hard one — stubbed out whole.
# The createRequire banner serves the CJS deps (signal-exit) that require()
# node builtins at runtime inside the ESM bundle.
# NODE_ENV=production is baked in so the bundle carries React's production
# build: the development build is slower, writes its warnings to cli.log and
# records a timing entry per render that nothing under node ever reads.
# `npm run phantom-cli` sets it too (package.json): the terminal has no devtools
# to consume the timing entries, and node never empties them (2026-09-03).
npx esbuild phantom-cli/index.tsx --bundle --platform=node --format=esm --target=node22 \
  --outfile="$OUT/stage/lib/phantom-cli.mjs" \
  --loader:.wasm=copy --loader:.node=copy --jsx=automatic \
  --alias:react-devtools-core=./scripts/shims/react-devtools-core.js \
  --define:process.env.PHANTOM_CLI_VERSION="\"$VERSION\"" \
  --define:process.env.NODE_ENV="\"production\"" \
  --banner:js="import { createRequire as __phantomCreateRequire } from 'node:module'; const require = __phantomCreateRequire(import.meta.url);" \
  --log-level=warning

# The sidecar rides as FILES beside the bundle (uv needs pyproject/uv.lock on
# disk; voice.ts resolves ./sidecar/ beside the module). The venv never ships.
mkdir -p "$OUT/stage/lib/sidecar"
tar -C phantom-cli/sidecar --exclude .venv --exclude __pycache__ -cf - . | tar -C "$OUT/stage/lib/sidecar" -xf -

# The server installer, shipped beside the cli for the rig and for reading
# offline — the wizard has the BOX download the release copy (provision.ts).
mkdir -p "$OUT/stage/scripts"
cp scripts/install.sh "$OUT/stage/scripts/install.sh"

printf '%s\n' "$VERSION" > "$OUT/stage/VERSION"

mkdir -p "$OUT/stage/bin"
# The installer reaches this shim through ~/.local/bin/phantom-cli, a symlink,
# so $0 is the link, not the file. Follow links first (macOS /bin/sh has no
# readlink -f) or DIR lands in ~/.local and the bundled node is never found.
cat > "$OUT/stage/bin/phantom-cli" <<'SHIM'
#!/bin/sh
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink -- "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *)  SELF="$(dirname -- "$SELF")/$LINK" ;;
  esac
done
DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd)"
exec "$DIR/node/bin/node" "$DIR/lib/phantom-cli.mjs" "$@"
SHIM
chmod 755 "$OUT/stage/bin/phantom-cli"

# ── one tarball per platform: stage + that platform's node ──────────────────
SUMS="$CACHE/SHASUMS256-$NODE_VERSION.txt"
[ -f "$SUMS" ] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$SUMS"

for platform in $PLATFORMS; do
  os="${platform%-*}"; arch="${platform#*-}"
  NODE_NAME="node-v$NODE_VERSION-$os-$arch"
  NODE_TAR="$CACHE/$NODE_NAME.tar.gz"
  if [ ! -f "$NODE_TAR" ]; then
    echo "→ fetching $NODE_NAME"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_NAME.tar.gz" -o "$NODE_TAR"
  fi
  WANT=$(grep " $NODE_NAME.tar.gz\$" "$SUMS" | awk '{print $1}')
  GOT=$(shasum -a 256 "$NODE_TAR" | awk '{print $1}')
  [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "✗ checksum mismatch for $NODE_NAME" >&2; exit 1; }

  ROOT="$OUT/pack/phantom-cli"
  rm -rf "$OUT/pack"; mkdir -p "$ROOT"
  cp -R "$OUT/stage/." "$ROOT/"
  # Only the runtime itself — npm and its tree stay out of the tarball.
  mkdir -p "$ROOT/node/bin"
  tar -C "$OUT/pack" -xzf "$NODE_TAR" "$NODE_NAME/bin/node"
  mv "$OUT/pack/$NODE_NAME/bin/node" "$ROOT/node/bin/node"
  rm -rf "$OUT/pack/$NODE_NAME"

  ASSET="$OUT/phantom-cli-$os-$arch.tar.gz"
  tar -C "$OUT/pack" -czf "$ASSET" phantom-cli
  echo "✓ $ASSET ($(du -h "$ASSET" | cut -f1 | tr -d ' '))"
done
rm -rf "$OUT/pack" "$OUT/stage"

( cd "$OUT" && shasum -a 256 phantom-cli-*.tar.gz > checksums.txt )
echo "✓ $OUT/checksums.txt"
