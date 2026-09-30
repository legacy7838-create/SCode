#!/usr/bin/env bash
# Builds every cdylib crate in packages/rust/crates into a napi-style .node binary.
#
# The naming contract, the cdylib/rlib classification, the copy, and the hash that
# proves the copy are all owned by zcode-packaging (docs/specs/rust-native-packaging.md).
# This script no longer contains a platform table or a crate-type grep; if you need to
# change how a binary is named, change crates/zcode-packaging/src/target.rs and run
# `pnpm --filter @zcode/rust gen:targets`.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --release

# `stage` derives the target from the host, classifies cdylib vs rlib from Cargo
# metadata, copies libzcode_*.{so,dylib,dll} to <crate>.<suffix>.node, and re-hashes
# every copy against its source. A crate with no artifact, or a copy that does not match,
# aborts the script (exit codes 2 and 3) rather than producing a partial payload.
cargo run --release -p zcode-packaging -- \
  plan --target host --surface dev --out target/native-plan.json
cargo run --release -p zcode-packaging -- \
  stage --plan target/native-plan.json
