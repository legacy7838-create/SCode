#!/bin/bash
set -euo pipefail

# The shell version of prepare-prebuilds has drifted with mjs many times.
# It is easy to repair the remote resource boundary on one hand, but on the other hand, it continues to keep the old directories and old comments in the warehouse.
# This is unified into a single implementation to avoid the dual-track problem of "the script can run but the directory responsibilities are inconsistent" in the future.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT_DIR/scripts/prepare-prebuilds.mjs" "$@"
