#!/usr/bin/env node
// Builds every cdylib crate in packages/rust/crates into a napi-style .node binary.
//
// The naming contract, the cdylib/rlib classification, the copy, and the hash that
// proves the copy are all owned by zcode-packaging (docs/specs/rust-native-packaging.md).
// This script no longer contains a platform table or a crate-type grep; if you need to
// change how a binary is named, change crates/zcode-packaging/src/target.rs and run
// `pnpm --filter @zcode/rust gen:targets`.
//
// Windows 上 pnpm 脚本环境没有 bash，因此这里用 Node 直接驱动 cargo（与
// build-native.sh 行为一致，跨平台）。
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(packageRoot);

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: packageRoot, shell: process.platform === "win32" });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with code=${code} signal=${signal}`));
    });
  });
}

try {
  await run("cargo", ["build", "--release"]);

  // `stage` derives the target from the host, classifies cdylib vs rlib from Cargo
  // metadata, copies libzcode_*.{so,dylib,dll} to <crate>.<suffix>.node, and re-hashes
  // every copy against its source. A crate with no artifact, or a copy that does not match,
  // aborts the script (exit codes 2 and 3) rather than producing a partial payload.
  await run("cargo", ["run", "--release", "-p", "zcode-packaging", "--", "plan", "--target", "host", "--surface", "dev", "--out", "target/native-plan.json"]);
  await run("cargo", ["run", "--release", "-p", "zcode-packaging", "--", "stage", "--plan", "target/native-plan.json"]);
} catch (error) {
  console.error(`[build-native] ${error.message}`);
  process.exit(1);
}
