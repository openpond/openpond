#!/usr/bin/env bash
set -euo pipefail

REPO="openpond/openpond"
VERSION="${OPENPOND_VERSION:-${OPENPOND_CODE_VERSION:-latest}}"
INSTALL_DIR="${OPENPOND_INSTALL_DIR:-${OPENPOND_CODE_INSTALL_DIR:-$HOME/.openpond/bin}}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin) OS="darwin" ;;
  linux) OS="linux" ;;
  *)
    echo "unsupported OS: $OS" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    echo "unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

TARBALL="openpond-cli-${OS}-${ARCH}.tar.gz"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${TARBALL}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "downloading ${URL}"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP_DIR/$TARBALL"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP_DIR/$TARBALL" "$URL"
else
  echo "curl or wget is required" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP_DIR/$TARBALL" -C "$TMP_DIR"
cp "$TMP_DIR/openpond" "$INSTALL_DIR/openpond"
cp "$TMP_DIR/op" "$INSTALL_DIR/op"
if [ -f "$TMP_DIR/package.json" ]; then
  cp "$TMP_DIR/package.json" "$INSTALL_DIR/package.json"
fi
chmod +x "$INSTALL_DIR/openpond" "$INSTALL_DIR/op"

echo "installed to $INSTALL_DIR"
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo "add it to PATH:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
fi
