// Reproducible staging for the Rust DB addon so the JS-free `zcode-db` path is a build step,
// not a hand-copied artifact. `cargo build --release` produces the cdylib; we rename the
// target-platform shared object to the fixed `zcode_db.node` the loader resolves in dev
// (see packages/services/src/session/zcodeDb.ts) and packaged hosts point at via ZCODE_DB_NATIVE.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { getTargetPlatform } from "./target-platform.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// packages/desktop/scripts → packages/desktop/zcode-db
const crateDir = resolve(here, "../zcode-db");
const stagedPath = join(crateDir, "zcode_db.node");

// cargo names the cdylib from the crate lib target, normalising the package name.
const SHARED_OBJECT_BY_OS = {
  linux: "libzcode_db.so",
  darwin: "libzcode_db.dylib",
  win32: "zcode_db.dll",
};

// N-API addon 的每个发行目标对应一个 Rust target triple。CI 为每个 OS 用原生 runner 构建自己的
// triple（macOS 交叉需要 osxcross + Apple SDK、Windows 需要 MSVC，Linux 本机都无法可靠产出），
// 因此这里只做「请求的 triple == 宿主 triple」判断：相等时走原来的无 --target 构建，不等时透传
// --target 给 cargo（交叉 arm64/其它 triple 由装了工具链的 CI runner 触发，本机 --check 不适用）。
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
  // CARGO_TARGET_DIR overrides the default `target/` next to the manifest.
  const root = process.env.CARGO_TARGET_DIR
    ? process.env.CARGO_TARGET_DIR
    : join(crateDir, "target");
  // 交叉构建产物落在 target/<triple>/release，原生构建（无 --target）落在 target/release。
  return triple ? join(root, triple, "release") : join(root, "release");
}

function resolveCargoArtifact(platform, triple) {
  const sharedObject = SHARED_OBJECT_BY_OS[platform.os];
  if (!sharedObject) throw new Error(`不支持的 zcode-db 目标平台: ${platform.key}`);
  const artifact = join(cargoReleaseDir(triple), sharedObject);
  if (!existsSync(artifact)) {
    throw new Error(
      `cargo 产物缺失: ${artifact}。cargo build --release${
        triple ? ` --target ${triple}` : ""
      } 是否在该平台成功执行?` +
        // Cross-compiling a N-API addon needs a target-specific Rust toolchain AND a matching
        // Node runtime; silently shipping a host-arch .node would crash the installed app.
        ` 如需跨平台产物，请在目标平台上执行本脚本(不支持仅设 ZCODE_TARGET_OS 交叉编译)。`,
    );
  }
  return { artifact, platformKey: platform.key };
}

function stage() {
  const platform = getTargetPlatform();
  const requestedTriple = TRIPLE_BY_PLATFORM_KEY[platform.key];
  if (!requestedTriple) throw new Error(`不支持的 zcode-db 目标平台: ${platform.key}`);
  // 只有当请求 triple 与宿主 triple 不同才透传 --target；保持默认 linux-x64 本机路径与产物目录不变。
  const triple = requestedTriple === hostTargetTriple() ? null : requestedTriple;
  const cargoArgs = ["build", "--release"];
  if (triple) cargoArgs.push("--target", triple);
  execFileSync("cargo", cargoArgs, { cwd: crateDir, stdio: "inherit" });
  const { artifact, platformKey } = resolveCargoArtifact(platform, triple);
  cpSync(artifact, stagedPath);
  if (!existsSync(stagedPath)) throw new Error(`zcode-db native 暂存失败: ${stagedPath}`);
  console.log(
    `[prepare:zcode-db-native] staged ${platformKey} addon: ${stagedPath} (${statSync(stagedPath).size} bytes)`,
  );
}

function check() {
  // Fast CI gate: actually load the staged addon and assert a known op is present, so a
  // present-but-unloadable file (wrong arch, stale ABI) fails here instead of at app boot.
  if (!existsSync(stagedPath)) {
    throw new Error(
      `zcode-db native addon 缺失: ${stagedPath}。请先运行 node scripts/prepare-zcode-db-native.mjs`,
    );
  }
  const addon = require(stagedPath);
  if (typeof addon?.bootstrapTasksIndex !== "function") {
    throw new Error(`zcode-db addon 已加载但缺少 bootstrapTasksIndex: ${stagedPath}`);
  }
  console.log(
    `[prepare:zcode-db-native] addon loads: ${stagedPath} (${statSync(stagedPath).size} bytes)`,
  );
}

if (process.argv.includes("--check")) check();
else stage();
