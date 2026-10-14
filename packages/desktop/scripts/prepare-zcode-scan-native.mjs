// Reproducible staging for the Rust workspace-scan addon so the JS-free `zcode-scan` path is a
// build step, not a hand-copied artifact. `cargo build --release` produces the cdylib; we rename
// the target-platform shared object to the fixed `zcode_scan.node` the loader resolves in dev
// (see packages/services/src/file/workspaceScanNative.ts) and packaged hosts point at via
// ZCODE_SCAN_NATIVE.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { getTargetPlatform } from "./target-platform.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// packages/desktop/scripts → packages/desktop/zcode-scan
const crateDir = resolve(here, "../zcode-scan");
const stagedPath = join(crateDir, "zcode_scan.node");

// cargo names the cdylib from the crate lib target, normalising the package name.
const SHARED_OBJECT_BY_OS = {
  linux: "libzcode_scan.so",
  darwin: "libzcode_scan.dylib",
  win32: "zcode_scan.dll",
};

const TRIPLE_BY_PLATFORM_KEY = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};

function hostTargetTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = /^host:\s+(\S+)$/m.exec(out);
  if (!match) throw new Error("无法从 rustc -vV 解析宿主 target triple");
  return match[1];
}

function cargoReleaseDir(triple) {
  const root = process.env.CARGO_TARGET_DIR
    ? process.env.CARGO_TARGET_DIR
    : join(crateDir, "target");
  return triple ? join(root, triple, "release") : join(root, "release");
}

function resolveCargoArtifact(platform, triple) {
  const sharedObject = SHARED_OBJECT_BY_OS[platform.os];
  if (!sharedObject) throw new Error(`不支持的 zcode-scan 目标平台: ${platform.key}`);
  const artifact = join(cargoReleaseDir(triple), sharedObject);
  if (!existsSync(artifact)) {
    throw new Error(
      `cargo 产物缺失: ${artifact}。cargo build --release${
        triple ? ` --target ${triple}` : ""
      } 是否在该平台成功执行? ` +
        `如需跨平台产物，请在目标平台上执行本脚本(不支持仅设 ZCODE_TARGET_OS 交叉编译)。`,
    );
  }
  return { artifact, platformKey: platform.key };
}

function stage() {
  const platform = getTargetPlatform();
  const requestedTriple = TRIPLE_BY_PLATFORM_KEY[platform.key];
  if (!requestedTriple) throw new Error(`不支持的 zcode-scan 目标平台: ${platform.key}`);
  const triple = requestedTriple === hostTargetTriple() ? null : requestedTriple;
  const cargoArgs = ["build", "--release"];
  if (triple) cargoArgs.push("--target", triple);
  execFileSync("cargo", cargoArgs, { cwd: crateDir, stdio: "inherit" });
  const { artifact, platformKey } = resolveCargoArtifact(platform, triple);
  cpSync(artifact, stagedPath);
  if (!existsSync(stagedPath)) throw new Error(`zcode-scan native 暂存失败: ${stagedPath}`);
  console.log(
    `[prepare:zcode-scan-native] staged ${platformKey} addon: ${stagedPath} (${statSync(stagedPath).size} bytes)`,
  );
}

function check() {
  if (!existsSync(stagedPath)) {
    throw new Error(
      `zcode-scan native addon 缺失: ${stagedPath}。请先运行 node scripts/prepare-zcode-scan-native.mjs`,
    );
  }
  const addon = require(stagedPath);
  if (typeof addon?.scanWorkspaceFilesPacked !== "function") {
    throw new Error(`zcode-scan addon 已加载但缺少 scanWorkspaceFilesPacked: ${stagedPath}`);
  }
  console.log(
    `[prepare:zcode-scan-native] addon loads: ${stagedPath} (${statSync(stagedPath).size} bytes)`,
  );
}

if (process.argv.includes("--check")) check();
else stage();
