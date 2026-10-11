#!/usr/bin/env node
// Post-bundle fix for the Linux AppImage: remove the shadowing libcrypto.so.3 that linuxdeploy
// bundles, then repack the AppImage in place.
//
// 背景（为什么需要这个脚本）：
//   Tauri 的 AppImage 打包会调用 linuxdeploy，后者会把 libcrypto.so.3（构建机的 OpenSSL
//   3.0.x）打进 AppDir，并在 AppRun 里把 `<mount>/usr/lib` 前置到 LD_LIBRARY_PATH。结果：只要
//   AppImage 的环境泄漏到它启动的子进程（shell、git、eza），这些工具就会加载 AppImage 里更旧
//   的 libcrypto，报出致命错误：
//     `libcrypto.so.3: version 'OPENSSL_3.6.0' not found (required by /usr/lib/libssl.so.3)`
//   宿主系统上更新的 OpenSSL 3.x 本来向后兼容（仍提供 OPENSSL_3.0.0 符号），把这一个库从
//   AppImage 里删掉，运行时就会回退到宿主版本，致命错误消失。
//
//   安全性依据（已用 readelf 实测）：
//     - libcrypto.so.3 不在主程序的 DT_NEEDED 闭包内；只有 libssh.so.4 / libsasl2.so.2 需要它，
//       而它们只要求 OPENSSL_3.0.0 符号，宿主的 OpenSSL 3.x 均提供。
//     - 对比：libpcre2-8.so.0（<- libglib <- 主程序）和 libsystemd.so.0（<- libwebkit2gtk
//       <- 主程序）都在闭包内，属硬依赖，不删——删了是拿白屏/崩溃换一条无害提示。
//   脚本在删除前仍会扫描主程序的 DT_NEEDED 闭包；若待删库真被主程序硬依赖，则拒绝删除并报错
//   退出（宁可失败，也不产出启动不了的 AppImage）。
//
//   必须保留的：WebKitGTK/GTK/GDK/pango/cairo/atk 系列、libsoup-3.0、libglib/libgio/
//   libgobject、libpcre2、libsystemd —— 主程序直接或间接依赖。
//
// 运行方式（CI 在 build 之后、上传之前调用；也可本地 release 构建后手动跑）：
//   node scripts/strip-appimage-system-libs.mjs          # 抽取 -> 删库 -> 原地重打包
//   node scripts/strip-appimage-system-libs.mjs --check  # 只校验产物，不重打包
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const appimageDir = join(desktopRoot, "src-tauri", "target", "release", "bundle", "appimage");
// host 资源在 AppImage 内的落点由 Tauri 的 BaseDirectory::Resource 决定：
// usr/lib/<productName>/host。tauri.prod.json 的 productName 是 "ZCode"。
const hostResourceRelDir = join("usr", "lib", "ZCode", "host");

// 需要从 AppImage 中移除的系统级库（见文件头“安全性依据”）。
//
// 目前只删 libcrypto.so.3：它是唯一一个“被打进 AppImage 且与宿主不兼容”的库，也正是
//   `libcrypto.so.3: version 'OPENSSL_3.6.0' not found (required by /usr/lib/libssl.so.3)`
// 的直接原因。
//
// 为什么不再删 libpcre2-8.so.0 / libsystemd.so.0（尽管最初想删）：
//   实测 readelf 依赖链显示它们在主程序的 DT_NEEDED 闭包内，属于硬依赖：
//     - libpcre2-8.so.0  <- libglib-2.0.so.0  <- 主程序
//     - libsystemd.so.0  <- libwebkit2gtk-4.1.so.0 / libjavascriptcoregtk-4.1.so.0 <- 主程序
//   删掉它们就等于删掉主程序的直接依赖，属于“用白屏/崩溃换噪音”的坏交易。`selectSafeToStrip`
//   的闭包校验会直接拒绝删除这类库——这正是它存在的意义。pcre2 的 `no version information`
//   提示本身无害（裸 SONAME，宿主版本照样满足）。
const SHADOWING_LIBS = ["libcrypto.so.3"];

// 打包态 host 侧车必须存在的文件；任一缺失说明 AppImage 结构被破坏。
const REQUIRED_HOST_FILES = [
  "node",
  "standalone.js",
  "zcode_db.node",
  join("agent", "zcode.cjs"),
  join("provider", "zcode-builtin.json"),
];

/**
 * 定位唯一的 AppImage 产物。多于一个说明有陈旧产物残留，直接报错而不是猜。
 *
 * @returns {string} AppImage 的绝对路径。
 */
function findAppImage() {
  if (!existsSync(appimageDir)) {
    throw new Error(
      `[appimage-strip] bundle dir missing: ${appimageDir}. Run \`tauri build --bundles appimage\` first.`,
    );
  }
  const images = readdirSync(appimageDir)
    .filter((name) => name.endsWith(".AppImage"))
    .map((name) => join(appimageDir, name));
  if (images.length === 0) {
    throw new Error(`[appimage-strip] no .AppImage found in ${appimageDir}`);
  }
  if (images.length > 1) {
    throw new Error(
      `[appimage-strip] expected exactly one .AppImage, found ${images.length}: ` +
        `${images.map((p) => basename(p)).join(", ")}. Clean the bundle dir first.`,
    );
  }
  return images[0];
}

/**
 * 解析给定 ELF 文件的 DT_NEEDED（直接依赖的 SONAME 列表）。
 *
 * 用 `readelf -d`（binutils，CI 与本地 release 构建都具备）。若 readelf 不可用则报错——本
 * 校验是“不删掉硬依赖库”的唯一保险，不能静默降级。
 *
 * @param {string} elfPath ELF 文件路径。
 * @returns {string[]} SONAME 列表（可能为空）。
 */
function readElfNeeded(elfPath) {
  let output;
  try {
    output = execFileSync("readelf", ["-d", elfPath], { encoding: "utf8" });
  } catch (error) {
    throw new Error(
      `[appimage-strip] readelf failed on ${elfPath} (needed for the DT_NEEDED safety guard): ${error.message}`,
    );
  }
  const needed = [];
  const pattern = /\(NEEDED\)\s+Shared library:\s+\[([^\]]+)\]/g;
  for (const match of output.matchAll(pattern)) {
    needed.push(match[1]);
  }
  return needed;
}

/**
 * 计算主程序二进制的 DT_NEEDED 闭包（在解包出的 AppDir 内逐层展开）。
 *
 * 只沿 AppDir 内存在的库继续展开；AppDir 外的库（glibc 等）视作宿主机提供，不再跟进。
 *
 * @param {string} appDir 解包出的 squashfs-root 目录。
 * @returns {Set<string>} 闭包内出现的所有 SONAME。
 */
function collectNeededClosure(appDir) {
  const libRoots = [
    join(appDir, "usr", "lib"),
    join(appDir, "usr", "lib", "x86_64-linux-gnu"),
  ];
  const closure = new Set();
  const queue = readElfNeeded(join(appDir, "usr", "bin", "zcode-desktop-tauri"));

  while (queue.length > 0) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    closure.add(name);
    for (const root of libRoots) {
      const candidate = join(root, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        queue.push(...readElfNeeded(candidate));
        break;
      }
    }
  }
  return closure;
}

/**
 * 用安全校验决定真正要删的库：待删库若出现在主程序 NEEDED 闭包内，则拒绝删除并报错。
 *
 * @param {Set<string>} closure 主程序 NEEDED 闭包。
 * @returns {string[]} 确认可安全删除的库名。
 */
function selectSafeToStrip(closure) {
  const blocked = SHADOWING_LIBS.filter((lib) => closure.has(lib));
  if (blocked.length > 0) {
    throw new Error(
      `[appimage-strip] refusing to strip libraries that are hard NEEDED by the main binary: ` +
        `${blocked.join(", ")}. Removing them would break the app; investigate the bundle instead.`,
    );
  }
  return [...SHADOWING_LIBS];
}

/**
 * 在解包出的 AppDir 中删除指定库（及其在 usr/lib/** 下的同名符号链接残留）。
 *
 * @param {string} appDir squashfs-root 目录。
 * @param {string[]} libs 要删除的库名。
 * @returns {string[]} 实际删除的文件路径。
 */
function stripLibsFromAppDir(appDir, libs) {
  const removed = [];
  const candidates = [
    join(appDir, "usr", "lib"),
    join(appDir, "usr", "lib", "x86_64-linux-gnu"),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    for (const lib of libs) {
      const target = join(dir, lib);
      if (existsSync(target)) {
        rmSync(target, { force: true });
        removed.push(target);
      }
    }
  }
  return removed;
}

/**
 * 使用 `--appimage-extract` 解包 AppImage 到临时目录。
 *
 * 注意：extract-and-run 的 AppImage 在部分环境下需要 FUSE；用 APPIMAGE_EXTRACT_AND_RUN=1
 * 让内部 runtime 免 FUSE 运行（CI 的 ubuntu-24.04 runner 默认没有 libfuse2）。
 *
 * @param {string} appImage AppImage 路径。
 * @returns {string} 解包出的 squashfs-root 绝对路径（临时目录内）。
 */
function extractAppImage(appImage) {
  const workDir = mkdtempSync(join(tmpdir(), "zcode-appimage-strip-"));
  execFileSync(appImage, ["--appimage-extract"], {
    cwd: workDir,
    stdio: "inherit",
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
  });
  const appDir = join(workDir, "squashfs-root");
  if (!existsSync(appDir)) {
    throw new Error(`[appimage-strip] extraction produced no squashfs-root in ${workDir}`);
  }
  return appDir;
}

/**
 * 解析 appimagetool 可执行文件路径：优先 $APPIMAGETOOL，其次 PATH。
 *
 * @returns {string} appimagetool 的路径。
 */
function resolveAppimagetool() {
  const fromEnv = process.env.APPIMAGETOOL?.trim();
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`[appimage-strip] APPIMAGETOOL points to a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }
  try {
    return execFileSync("which", ["appimagetool"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "[appimage-strip] appimagetool not found. Install it (CI does this) or set $APPIMAGETOOL.",
    );
  }
}

/**
 * 用 appimagetool 把 AppDir 重打包成 AppImage，并原地替换原文件。
 *
 * 用 appimagetool 自带的默认 runtime（即 CI 里安装的那个版本的 runtime）——不要手工截取原
 * AppImage 的 runtime 字节再注入：实测那样得到的 runtime 会 core dump。默认 runtime 与
 * appimagetool 本体版本匹配，最稳。
 *
 * 先写到临时文件再 rename，保证失败时不会留下一个半成品覆盖掉可用的产物。
 *
 * @param {string} appDir squashfs-root 目录。
 * @param {string} appImageOut 目标 AppImage 路径（会被原地替换）。
 */
function repackAppImage(appDir, appImageOut) {
  const appimagetool = resolveAppimagetool();
  const tempOut = `${appImageOut}.stripped`;
  rmSync(tempOut, { force: true });
  execFileSync(appimagetool, ["--no-appstream", appDir, tempOut], {
    stdio: "inherit",
    env: {
      ...process.env,
      ARCH: process.arch === "arm64" ? "aarch64" : "x86_64",
      // appimagetool 自身是 AppImage；免 FUSE 运行。
      APPIMAGE_EXTRACT_AND_RUN: "1",
    },
  });
  if (!existsSync(tempOut)) {
    throw new Error(`[appimage-strip] appimagetool produced no output at ${tempOut}`);
  }
  chmodSync(tempOut, 0o755);
  renameSync(tempOut, appImageOut);
}

/**
 * 校验 AppImage：待删库已消失，且打包态 host 侧车文件齐全。
 *
 * @param {string} appImage AppImage 路径。
 * @returns {{strippedFound: string[], missingHost: string[]}} 校验结果（两边都应为空）。
 */
function inspectAppImage(appImage) {
  const workDir = mkdtempSync(join(tmpdir(), "zcode-appimage-check-"));
  try {
    execFileSync(appImage, ["--appimage-extract"], {
      cwd: workDir,
      stdio: "inherit",
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
    });
    const appDir = join(workDir, "squashfs-root");
    const strippedFound = [];
    for (const dir of [join(appDir, "usr", "lib"), join(appDir, "usr", "lib", "x86_64-linux-gnu")]) {
      if (!existsSync(dir)) continue;
      for (const lib of SHADOWING_LIBS) {
        if (existsSync(join(dir, lib))) strippedFound.push(join(dir, lib));
      }
    }
    const missingHost = REQUIRED_HOST_FILES.filter(
      (rel) => !existsSync(join(appDir, hostResourceRelDir, rel)),
    );
    return { strippedFound, missingHost };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const appImage = findAppImage();

  if (checkOnly) {
    const { strippedFound, missingHost } = inspectAppImage(appImage);
    if (strippedFound.length > 0) {
      throw new Error(
        `[appimage-strip] shadowing libs still present in ${basename(appImage)}: ` +
          `${strippedFound.map((p) => basename(p)).join(", ")}`,
      );
    }
    if (missingHost.length > 0) {
      throw new Error(
        `[appimage-strip] host sidecar files missing in ${basename(appImage)}: ${missingHost.join(", ")}`,
      );
    }
    console.log(`[appimage-strip] check OK: no shadowing libs, host sidecar intact`);
    return;
  }

  // 先解包做安全校验，避免“只读检查”和“真删”之间产生分歧。
  const appDir = extractAppImage(appImage);
  const closure = collectNeededClosure(appDir);
  const toStrip = selectSafeToStrip(closure);

  const present = SHADOWING_LIBS.filter((lib) =>
    [join(appDir, "usr", "lib"), join(appDir, "usr", "lib", "x86_64-linux-gnu")].some((dir) =>
      existsSync(join(dir, lib)),
    ),
  );
  if (present.length === 0) {
    console.log("[appimage-strip] nothing to strip; AppImage already clean");
    rmSync(dirname(appDir), { recursive: true, force: true });
    return;
  }

  const removed = stripLibsFromAppDir(appDir, toStrip);
  console.log(
    `[appimage-strip] removing ${removed.length} shadowing lib(s): ` +
      removed.map((p) => basename(p)).join(", "),
  );

  repackAppImage(appDir, appImage);
  rmSync(dirname(appDir), { recursive: true, force: true });

  const { strippedFound, missingHost } = inspectAppImage(appImage);
  if (strippedFound.length > 0 || missingHost.length > 0) {
    throw new Error(
      `[appimage-strip] post-repack verification failed: ` +
        `remaining=${strippedFound.length}, missingHost=${missingHost.length}`,
    );
  }
  console.log(`[appimage-strip] repacked ${basename(appImage)} without shadowing system libs`);
}

main();
