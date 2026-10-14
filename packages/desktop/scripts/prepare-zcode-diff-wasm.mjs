// Reproducible staging for the Rust line-diff/LCS WASM kernel, so the renderer's diff path is a
// build step rather than a hand-copied artifact.
//
// Mirrors `prepare-zcode-score-wasm.mjs` (crate-type guard, wasm-bindgen version pin, per-target
// staging under `pkg/`) and differs only in the crate/output names and the `--check` trivial call.
// See that file's header for why `cargo build` alone is not a deliverable and why there are two
// targets.
//
// One difference from the score kernel that matters for the renderer: the `web` payload for THIS
// kernel is instantiated **synchronously** (`initSync`) by the renderer facade, because the diff is
// computed during React render. See `packages/ui/src/lib/diffWasm.ts` and
// `spec/native-boundary-line-diff.md` §1.6.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// packages/desktop/scripts → packages/desktop/zcode-diff-wasm
const crateDir = resolve(here, "../zcode-diff-wasm");

const WASM_TARGET = "wasm32-unknown-unknown";

// wasm-bindgen derives the emitted filenames from --out-name:
//   <out-name>.js        glue
//   <out-name>_bg.wasm   the actual module payload
// The glue is FILENAME-COUPLED to `<out-name>_bg.wasm`, so that pair must be staged together and
// never renamed apart.
const WASM_BINDGEN_TARGETS = [
  {
    // The differential harness runs this under Node via `require()`.
    key: "nodejs",
    outName: "zcode_diff",
    stagedWasm: join(crateDir, "zcode_diff.wasm"),
  },
  {
    // Renderer: browser ESM. The facade compiles this synchronously with `initSync`.
    key: "web",
    outName: "zcode_diff_web",
    stagedWasm: join(crateDir, "zcode_diff_web_bg.wasm"),
  },
];

// Where the glue-coupled pairs live, kept out of the crate root so the staged `*.wasm` files stay
// the only top-level build artifacts (mirrors `zcode_score.wasm` / `zcode_score_web_bg.wasm`).
const pkgDir = join(crateDir, "pkg");

/**
 * wasm-bindgen emits CommonJS glue (`exports.x = ...`) but names it `<out-name>.js`. Inside this
 * package that extension is treated as ESM (`packages/desktop/package.json` is `"type": "module"`),
 * so `require()` of the glue fails with "exports is not defined in ES module scope". A
 * `{ "type": "commonjs" }` marker in the `pkg/` directory makes Node resolve the `.js` files there
 * as CommonJS again. Written by this script (not left to chance) so a clean checkout behaves the
 * same as a working one.
 */
function writePkgCommonJsMarker() {
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), '{ "type": "commonjs" }\n');
}

function hostTargetTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = /^host:\s+(\S+)$/m.exec(out);
  if (!match) throw new Error("无法从 rustc -vV 解析宿主 target triple");
  return match[1];
}

/**
 * Fail fast if the `wasm32-unknown-unknown` std is missing, so the failure names the toolchain
 * rather than surfacing as an opaque link error after the whole graph compiles.
 */
function assertWasmTargetInstalled() {
  let installed;
  try {
    installed = execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
  } catch {
    // No rustup (e.g. a distro toolchain) — cargo will report the real problem itself.
    return;
  }
  if (!installed.split("\n").some((line) => line.trim() === WASM_TARGET)) {
    throw new Error(
      `缺少 rustup target: ${WASM_TARGET}。请先运行: rustup target add ${WASM_TARGET}`,
    );
  }
}

/**
 * Return the body of the `[lib]` table, or null when there is none.
 *
 * Split on lines rather than regex: the section body contains `crate-type = ["cdylib"]`, whose `[`
 * defeats a `[^\[]*` scan.
 */
function readLibSection(manifest) {
  const lines = manifest.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[lib]");
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const nextSection = rest.findIndex((line) => /^\s*\[/.test(line));
  return (nextSection === -1 ? rest : rest.slice(0, nextSection)).join("\n");
}

/**
 * Strip TOML line comments so a documented example cannot be mistaken for a real setting.
 *
 * This crate's `[lib]` comment block writes `crate-type = ["cdylib", "rlib"]` verbatim as the napi
 * counter-example; the raw manifest would read THAT as the declared crate-type. A `#` inside a
 * quoted string is not a comment, hence the small scanner rather than a naive split.
 */
function stripTomlComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      let inString = false;
      let quote = "";
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (inString) {
          if (char === "\\") {
            index += 1;
            continue;
          }
          if (char === quote) inString = false;
          continue;
        }
        if (char === '"' || char === "'") {
          inString = true;
          quote = char;
          continue;
        }
        if (char === "#") return line.slice(0, index);
      }
      return line;
    })
    .join("\n");
}

/**
 * Guard the `crate-type` landmine BEFORE building.
 *
 * `["cdylib", "rlib"]` is correct for the napi crates here (they need `rlib` to link unit tests) but
 * silently strips the `__wasm_bindgen` custom section from a wasm build: `cargo build` SUCCEEDS and
 * emits a plausible .wasm, then the wasm-bindgen CLI fails with an opaque `clone_ref` error.
 */
function assertCrateTypeIsCdylibOnly() {
  const manifestPath = join(crateDir, "Cargo.toml");
  if (!existsSync(manifestPath)) {
    throw new Error(`zcode-diff-wasm manifest 缺失: ${manifestPath}`);
  }
  const manifest = readFileSync(manifestPath, "utf8");
  const libSection = readLibSection(stripTomlComments(manifest));
  const crateTypes =
    libSection === null ? null : /crate-type\s*=\s*\[([^\]]*)\]/.exec(libSection)?.[1];
  const declared = (crateTypes ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0);
  if (declared.length === 0) {
    throw new Error(
      `${manifestPath} 的 [lib] 未声明 crate-type。WASM crate 必须显式写 crate-type = ["cdylib"]。`,
    );
  }
  const extras = declared.filter((entry) => entry !== "cdylib");
  if (extras.length > 0) {
    throw new Error(
      `${manifestPath} 的 crate-type 必须是 cdylib only，当前为 [${declared.join(", ")}]。` +
        `包含 ${extras.join(", ")} 会剥离 __wasm_bindgen custom section：cargo build 仍会成功并产出 ` +
        `看似正常的 .wasm，随后 wasm-bindgen CLI 报 "failed to find intrinsics to enable ` +
        `clone_ref function"。注意 napi crate(zcode-db/zcode-scan)用 ["cdylib","rlib"] 是为了跑 ` +
        `Rust 单测，WASM crate 不能照抄。`,
    );
  }
}

/**
 * The wasm-bindgen CLI version must match the crate's pinned dependency exactly, otherwise the
 * version-coupled glue and custom sections mismatch with the same opaque `clone_ref` failure.
 */
function assertWasmBindgenVersionsMatch() {
  const cliVersionOut = execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" });
  const cliVersion = /(\d+\.\d+\.\d+)/.exec(cliVersionOut)?.[1];
  if (!cliVersion) {
    throw new Error(`无法解析 wasm-bindgen CLI 版本: ${cliVersionOut.trim()}`);
  }
  const manifest = readFileSync(join(crateDir, "Cargo.toml"), "utf8");
  const pinned = /wasm-bindgen\s*=\s*"=([^"]+)"/.exec(manifest)?.[1];
  if (pinned === undefined) {
    throw new Error(
      `${join(crateDir, "Cargo.toml")} 未用 "=x.y.z" 精确锁定 wasm-bindgen 版本。` +
        `caret 范围可能解析到 CLI 不认识的新版本，重现 clone_ref 失败。`,
    );
  }
  if (pinned !== cliVersion) {
    throw new Error(
      `wasm-bindgen 版本不匹配: CLI=${cliVersion}, Cargo.toml pin=${pinned}。` +
        `CLI 与 crate 依赖必须完全一致，请安装匹配的 wasm-bindgen-cli。`,
    );
  }
  return cliVersion;
}

function cargoTargetRoot() {
  return process.env.CARGO_TARGET_DIR ? process.env.CARGO_TARGET_DIR : join(crateDir, "target");
}

function buildWasmModule() {
  const targetRoot = cargoTargetRoot();
  execFileSync(
    "cargo",
    ["build", "--release", "--target", WASM_TARGET, "--target-dir", targetRoot],
    { cwd: crateDir, stdio: "inherit" },
  );
  // cargo names the artifact from the LIB TARGET name (package name with dashes normalised to
  // underscores): `zcode-diff-wasm` -> `zcode_diff_wasm.wasm`.
  const releaseDir = join(targetRoot, WASM_TARGET, "release");
  const artifact = join(releaseDir, "zcode_diff_wasm.wasm");
  if (!existsSync(artifact)) {
    const produced = readdirSync(releaseDir)
      .filter((entry) => entry.endsWith(".wasm"))
      .join(", ");
    throw new Error(
      `cargo 产物缺失: ${artifact}。cargo build --release --target ${WASM_TARGET} 是否成功执行?` +
        (produced
          ? ` 该目录实际的 .wasm 产物: ${produced}`
          : ` 该目录没有任何 .wasm: ${releaseDir}`),
    );
  }
  return artifact;
}

/**
 * Run `wasm-bindgen` once per consumer target and copy the coupled payload to its fixed name. The
 * `_bg.wasm` is copied (not moved) because the glue next to it is hard-coupled to that filename.
 */
function stageTarget(artifact, target, cliVersion) {
  const outDir = join(pkgDir, target.key);
  // Wipe first: wasm-bindgen merges into an existing --out-dir, so a stale file from an earlier
  // build (or a renamed export) would silently survive and be shipped.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  try {
    execFileSync(
      "wasm-bindgen",
      [artifact, "--target", target.key, "--out-dir", outDir, "--out-name", target.outName],
      { cwd: crateDir, stdio: "inherit" },
    );
  } catch (error) {
    const detail = error instanceof Error ? (error.stderr ?? error.message) : String(error);
    throw new Error(
      `wasm-bindgen (${cliVersion}) 处理 ${target.key} 目标失败: ${detail}\n` +
        `若报 "failed to find intrinsics to enable \`clone_ref\` function"，先确认 ` +
        `Cargo.toml 的 crate-type 只有 cdylib(没有 rlib)、wasm-bindgen 依赖是 "=版本号" 精确锁定、` +
        `且 wasm-bindgen CLI 版本与之完全一致。`,
    );
  }

  const boundWasm = join(outDir, `${target.outName}_bg.wasm`);
  const glue = join(outDir, `${target.outName}.js`);
  if (!existsSync(boundWasm) || !existsSync(glue)) {
    throw new Error(`wasm-bindgen 未产出预期文件: ${glue} / ${boundWasm}(out-dir: ${outDir})`);
  }
  copyFileSync(boundWasm, target.stagedWasm);
  if (!existsSync(target.stagedWasm)) {
    throw new Error(`zcode-diff wasm 暂存失败: ${target.stagedWasm}`);
  }
  return { outDir, stagedBytes: statSync(target.stagedWasm).size };
}

function stage() {
  assertCrateTypeIsCdylibOnly();
  assertWasmTargetInstalled();
  const cliVersion = assertWasmBindgenVersionsMatch();
  const host = hostTargetTriple();

  console.log(`[prepare:zcode-diff-wasm] host ${host}, wasm-bindgen CLI ${cliVersion}`);
  const artifact = buildWasmModule();
  writePkgCommonJsMarker();
  for (const target of WASM_BINDGEN_TARGETS) {
    const { outDir, stagedBytes } = stageTarget(artifact, target, cliVersion);
    console.log(
      `[prepare:zcode-diff-wasm] staged ${target.key}: ${target.stagedWasm} ` +
        `(${stagedBytes} bytes, glue: ${outDir})`,
    );
  }
}

/**
 * CI gate: prove each staged artifact is present AND loadable.
 *
 * `WebAssembly.validate` alone only proves the bytes are structurally valid — it would pass a module
 * missing the wasm-bindgen ABI shims and then fail at the first real call. So the nodejs payload
 * additionally goes through its generated glue with a real diff call, which is the same
 * "present-but-unloadable must fail here, not at app boot" posture as the sibling prepare scripts.
 */
function check() {
  for (const target of WASM_BINDGEN_TARGETS) {
    if (!existsSync(target.stagedWasm)) {
      throw new Error(
        `zcode-diff wasm 缺失: ${target.stagedWasm}。请先运行 node scripts/prepare-zcode-diff-wasm.mjs`,
      );
    }
    const bytes = readFileSync(target.stagedWasm);
    if (!WebAssembly.validate(bytes)) {
      throw new Error(`zcode-diff wasm 结构非法(WebAssembly.validate 失败): ${target.stagedWasm}`);
    }
  }

  const gluePath = join(pkgDir, "nodejs", "zcode_diff.js");
  if (!existsSync(gluePath)) {
    throw new Error(
      `nodejs glue 缺失: ${gluePath}。请先运行 node scripts/prepare-zcode-diff-wasm.mjs`,
    );
  }
  const diff = require(gluePath);
  for (const symbol of ["diff_patch", "diff_counts", "line_change_stat", "max_diff_cells"]) {
    if (typeof diff[symbol] !== "function") {
      throw new Error(`zcode-diff wasm 已加载但缺少导出 ${symbol}: ${gluePath}`);
    }
  }

  // Trivial round-trip: one changed line must yield exactly one add and one remove, and the patch
  // must carry the header. This touches the real DP rather than just validating bytes.
  // `Vec<u32>` crosses the ABI as a `Uint32Array`, not a JS Array.
  const stat = diff.line_change_stat("a\nb\nc", "a\nB\nc");
  if (stat.length !== 2 || stat[0] !== 1 || stat[1] !== 1) {
    throw new Error(`line_change_stat("a\\nb\\nc","a\\nB\\nc") 应返回 [1,1]，实际返回 ${stat}`);
  }
  const patch = diff.diff_patch("a\nb", "a\nB", "f.txt", -1);
  if (typeof patch !== "string" || !patch.includes("diff --git a/f.txt b/f.txt")) {
    throw new Error(`diff_patch 未产出预期 patch: ${String(patch).slice(0, 80)}`);
  }
  const counts = diff.diff_counts("a\nb", "a\nB", "f.txt", -1);
  if (counts.length !== 2 || counts[0] !== 1 || counts[1] !== 1) {
    throw new Error(`diff_counts 应为 [1,1]，实际为 ${counts}`);
  }
  if (typeof diff.max_diff_cells() !== "number") {
    throw new Error("max_diff_cells() 应返回 number");
  }

  for (const target of WASM_BINDGEN_TARGETS) {
    console.log(
      `[prepare:zcode-diff-wasm] ${target.key} artifact loads: ${target.stagedWasm} ` +
        `(${statSync(target.stagedWasm).size} bytes)`,
    );
  }
  console.log("[prepare:zcode-diff-wasm] nodejs glue exports + trivial diff call: OK");
}

if (process.argv.includes("--check")) check();
else stage();
