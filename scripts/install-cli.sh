#!/bin/sh
# ============================================================================
# phantom-cli installer (macOS + Linux)
# ============================================================================
# One-liner:
#
#   curl -fsSL https://raw.githubusercontent.com/stephengpope/phantom-looper/main/scripts/install-cli.sh | sh
#
# Zero questions — deliberately. This script only downloads, verifies and
# links; every decision (where the server goes, which model key) belongs to
# `phantom-cli setup-backend`, where it is real code with real screens and
# secrets never touch a shell.
#
# What it does:
#   1. Detects the platform (darwin/linux, arm64/x64).
#   2. Downloads the release tarball — self-contained: the app, the voice
#      sidecar's files, the server installer, and a pinned Node runtime.
#      PHANTOM_CLI_VERSION=vX.Y.Z pins a release; default is latest.
#   3. Verifies it against the release's checksums.txt.
#   4. Unpacks to ~/.phantom-cli/app/<version> and points ONE symlink at it:
#      ~/.local/bin/phantom-cli. Re-running (or `phantom-cli` self-updating
#      later) just moves that symlink — the old version stays until replaced.
#   5. Tells you if ~/.local/bin is not on PATH.
#
# Nothing here needs root and nothing touches the system outside
# ~/.phantom-cli and ~/.local/bin.
# ============================================================================
set -eu

REPO="${PHANTOM_CLI_REPO:-stephengpope/phantom-looper}"
VERSION="${PHANTOM_CLI_VERSION:-}"

say()  { printf '\033[0;36m→\033[0m %s\n' "$1"; }
ok()   { printf '\033[0;32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[0;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar  >/dev/null 2>&1 || fail "tar is required"

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) fail "unsupported OS: $(uname -s) (macOS and Linux only)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac
ASSET="phantom-cli-$OS-$ARCH.tar.gz"

if [ -n "$VERSION" ]; then BASE="https://github.com/$REPO/releases/download/$VERSION"
else                       BASE="https://github.com/$REPO/releases/latest/download"; fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "Downloading $ASSET${VERSION:+ ($VERSION)}..."
curl -fsSL "$BASE/$ASSET" -o "$TMP/$ASSET" \
  || fail "could not download $BASE/$ASSET — is there a release yet?"
curl -fsSL "$BASE/checksums.txt" -o "$TMP/checksums.txt" \
  || fail "could not download the release's checksums.txt"

WANT=$(grep " $ASSET\$" "$TMP/checksums.txt" | cut -d' ' -f1)
[ -n "$WANT" ] || fail "checksums.txt has no entry for $ASSET"
if command -v shasum >/dev/null 2>&1; then GOT=$(shasum -a 256 "$TMP/$ASSET" | cut -d' ' -f1)
else GOT=$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1); fi
[ "$WANT" = "$GOT" ] || fail "checksum mismatch for $ASSET — refusing to install it"
ok "Checksum verified"

tar -C "$TMP" -xzf "$TMP/$ASSET"
GOT_VERSION=$(cat "$TMP/phantom-cli/VERSION")
APP_DIR="$HOME/.phantom-cli/app/$GOT_VERSION"

mkdir -p "$HOME/.phantom-cli/app" "$HOME/.local/bin"
chmod 700 "$HOME/.phantom-cli" 2>/dev/null || true
rm -rf "$APP_DIR"
mv "$TMP/phantom-cli" "$APP_DIR"
ln -sf "$APP_DIR/bin/phantom-cli" "$HOME/.local/bin/phantom-cli"
ok "phantom-cli $GOT_VERSION installed"

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    say "~/.local/bin is not on your PATH — add it to your shell profile:"
    printf '\n    export PATH="$HOME/.local/bin:$PATH"\n\n' ;;
esac

printf '\nNext:\n\n    phantom-cli setup-backend    # need a server? installs one over ssh\n    phantom-cli                  # have one? /server pairs it\n'
