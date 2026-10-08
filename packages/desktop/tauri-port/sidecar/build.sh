#!/usr/bin/env bash
# Build the trivial echo sidecar into the Tauri externalBin location.
#
# Produces `packages/desktop/src-tauri/binaries/zcode-echo-<rust-target-triple>`: a single bundled
# ESM file with a `#!/usr/bin/env node` shebang and the executable bit set (SIDECAR-PACKAGING.md §2/§3).
# Run from anywhere; paths are resolved relative to this script.
set -euo pipefail

# Directory holding this script: packages/desktop/tauri-port/sidecar
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ESBUILD="$DESKTOP_DIR/../../node_modules/.bin/esbuild"
OUT_DIR="$DESKTOP_DIR/src-tauri/binaries"

# Rust target triple (e.g. x86_64-unknown-linux-gnu) — Tauri matches externalBin files by this suffix.
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
OUT="$OUT_DIR/zcode-echo-$TRIPLE"

mkdir -p "$OUT_DIR"

# The bundle is CJS, but `packages/desktop/package.json` sets `"type": "module"`, which Node inherits
# for the extensionless externalBin file and rejects `require`. Pin the binaries dir back to commonjs.
printf '{\n  "type": "commonjs"\n}\n' > "$OUT_DIR/package.json"

# `ws` is CommonJS and uses internal `require()` calls, so we must emit CJS: esbuild's ESM output
# cannot service a dynamic `require` of Node builtins ("Dynamic require of ... is not supported").
# bufferutil / utf-8-validate are optional native accelerators that `ws` requires behind try/catch;
# keep them external so esbuild never tries to resolve (and fail on) the absent native modules.
"$ESBUILD" "$SCRIPT_DIR/echo.mts" \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node22 \
  --banner:js='#!/usr/bin/env node' \
  --external:bufferutil \
  --external:utf-8-validate \
  --outfile="$OUT"

# esbuild does not set the exec bit; the Linux sidecar needs it (SIDECAR-PACKAGING.md §8 Linux risk).
chmod 755 "$OUT"

echo "built: $OUT"
