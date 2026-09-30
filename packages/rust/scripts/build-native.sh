#!/usr/bin/env bash
# Builds every crate in packages/rust/crates into a napi-style .node binary.
# Output name must match packages/rust/src/loader.ts (nativePlatformTarget).
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="$(rustc -vV | sed -n 's/^host: //p')"
case "$HOST" in
  x86_64-unknown-linux-gnu) TARGET_SUFFIX="linux-x64-gnu"; LIB_EXT="so" ;;
  aarch64-unknown-linux-gnu) TARGET_SUFFIX="linux-arm64-gnu"; LIB_EXT="so" ;;
  x86_64-apple-darwin) TARGET_SUFFIX="darwin-x64"; LIB_EXT="dylib" ;;
  aarch64-apple-darwin) TARGET_SUFFIX="darwin-arm64"; LIB_EXT="dylib" ;;
  x86_64-pc-windows-msvc) TARGET_SUFFIX="win32-x64-msvc"; LIB_EXT="dll" ;;
  aarch64-pc-windows-msvc) TARGET_SUFFIX="win32-arm64-msvc"; LIB_EXT="dll" ;;
  *) echo "[build-native] unsupported host triple: $HOST" >&2; exit 1 ;;
esac

cargo build --release

shopt -s nullglob
for crate_dir in crates/*/; do
  crate="$(basename "$crate_dir")"
  manifest="${crate_dir}Cargo.toml"

  # Only `cdylib` crates produce a napi `.node`. Crates whose `[lib] crate-type` is
  # `rlib` (zcode-rpc-server) are linked directly into the Tauri host and emit no
  # shared object, so demanding a `.so`/`.dylib`/`.dll` for them aborts the build.
  # The crate-type is read from the manifest rather than hardcoding a skip list so a
  # future rlib crate is handled automatically.
  if ! grep -qE '^[[:space:]]*crate-type[[:space:]]*=[[:space:]]*\[[^]]*"cdylib"' "$manifest"; then
    echo "[build-native] skip ${crate} (no cdylib crate-type; not a napi binary)"
    continue
  fi

  lib="${crate//-/_}"
  if [[ "$LIB_EXT" == "dll" ]]; then
    src="target/release/${lib}.dll"
  else
    src="target/release/lib${lib}.${LIB_EXT}"
  fi
  if [[ ! -f "$src" ]]; then
    echo "[build-native] missing artifact for ${crate}: ${src}" >&2
    exit 1
  fi
  cp "$src" "./${crate}.${TARGET_SUFFIX}.node"
  echo "[build-native] ${crate} -> ${crate}.${TARGET_SUFFIX}.node"
done
