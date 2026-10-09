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

function cargoReleaseDir() {
  // CARGO_TARGET_DIR overrides the default `target/` next to the manifest.
  if (process.env.CARGO_TARGET_DIR) return join(process.env.CARGO_TARGET_DIR, "release");
  return join(crateDir, "target", "release");
}

function resolveCargoArtifact() {
  const platform = getTargetPlatform();
  const sharedObject = SHARED_OBJECT_BY_OS[platform.os];
  if (!sharedObject) throw new Error(`不支持的 zcode-db 目标平台: ${platform.key}`);
  const artifact = join(cargoReleaseDir(), sharedObject);
  if (!existsSync(artifact)) {
    throw new Error(
      `cargo 产物缺失: ${artifact}。cargo build --release 是否在该平台成功执行?` +
        // Cross-compiling a N-API addon needs a target-specific Rust toolchain AND a matching
        // Node runtime; silently shipping a host-arch .node would crash the installed app.
        ` 如需跨平台产物，请在目标平台上执行本脚本(不支持仅设 ZCODE_TARGET_OS 交叉编译)。`,
    );
  }
  return { artifact, platformKey: platform.key };
}

function stage() {
  execFileSync("cargo", ["build", "--release"], { cwd: crateDir, stdio: "inherit" });
  const { artifact, platformKey } = resolveCargoArtifact();
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
