// Reproducible staging for the Rust fuzzy-score WASM kernel, so the browser-side scoring path is a
// build step rather than a hand-copied artifact.
//
// This mirrors `prepare-zcode-scan-native.mjs` (stage()/check(), explicit errors, artifact resolved
// from a predictable cargo dir) but differs in two ways that are NOT stylistic:
//
//   1. There is no host/target triple decision. `wasm32-unknown-unknown` is the only target and it
//      builds on every host, so unlike the native addon there is nothing to cross-compile and no
//      "requested triple == host triple" branch. The host triple is still read, but only to make
//      the toolchain diagnostics below name the actual host.
//
//   2. There are TWO build steps and therefore two staged artifacts, because there are two
//      consumers: the desktop host (Node) and the renderer worker (browser). `cargo build` alone
//      is NOT a usable deliverable — it emits a raw wasm with no JS glue and no ABI shims, so it
//      cannot be instantiated from JS. `wasm-bindgen` is the step that actually produces something
//      loadable.
//
// No wasm-pack: `cargo build --target wasm32-unknown-unknown --release` plus the `wasm-bindgen`
// CLI is the whole pipeline, and adding a second toolchain dependency for the same output is not
// worth the extra failure surface.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// packages/desktop/scripts → packages/desktop/zcode-score-wasm
const crateDir = resolve(here, "../zcode-score-wasm");

const WASM_TARGET = "wasm32-unknown-unknown";

// wasm-bindgen derives the emitted filenames from --out-name:
//   <out-name>.js        glue
//   <out-name>_bg.wasm   the actual module payload
// The glue is FILENAME-COUPLED to `<out-name>_bg.wasm` (the nodejs glue readFileSync's it relative
// to __dirname), so that pair must be staged together and never renamed apart.
const WASM_BINDGEN_TARGETS = [
  {
    // Desktop host: CommonJS `require()`.
    key: "nodejs",
    outName: "zcode_score",
    stagedWasm: join(crateDir, "zcode_score.wasm"),
  },
  {
    // Renderer worker: browser ESM + fetch/instantiateStreaming.
    key: "web",
    outName: "zcode_score_web",
    stagedWasm: join(crateDir, "zcode_score_web_bg.wasm"),
  },
];

// Where the glue-coupled pairs live. Kept out of the crate root so the staged `*.wasm` files stay
// the only top-level build artifacts, mirroring how `zcode_scan.node` sits next to `Cargo.toml`.
const pkgDir = join(crateDir, "pkg");

function hostTargetTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = /^host:\s+(\S+)$/m.exec(out);
  if (!match) throw new Error("无法从 rustc -vV 解析宿主 target triple");
  return match[1];
}

/**
 * Fail fast if the `wasm32-unknown-unknown` std is missing.
 *
 * Without this, cargo reports the missing target as an opaque link error after compiling the whole
 * dependency graph, which reads like a code problem rather than a toolchain one.
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
 * Split on lines rather than regex: the section body contains `crate-type = ["cdylib"]`, whose
 * `[` defeats a `[^\[]*` scan, and an `m`-flagged `\s*$` terminates the match at the first line
 * end rather than the end of input. Both mistakes are silent — they just yield an empty section.
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
 * This crate's own `[lib]` comment block explains the landmine by writing
 * `crate-type = ["cdylib", "rlib"]` verbatim as the napi counter-example. Matching the raw manifest
 * would read THAT as the declared crate-type and reject a perfectly correct manifest. A `#` inside
 * a quoted string is not a comment, hence the small scanner rather than a naive split.
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
 * `crate-type = ["cdylib", "rlib"]` is correct for the napi crates here (zcode-db, zcode-scan) so
 * their unit tests can link the lib — but that combination silently strips the `__wasm_bindgen`
 * custom section from a wasm build. `cargo build` still SUCCEEDS and emits a plausible ~50KB .wasm;
 * the failure only surfaces later in the `wasm-bindgen` CLI as:
 *     error: failed to find intrinsics to enable `clone_ref` function
 * which reads like a wasm-bindgen bug rather than a manifest mistake. Checking the manifest up
 * front turns a confusing two-stage failure into one actionable message.
 */
function assertCrateTypeIsCdylibOnly() {
  const manifestPath = join(crateDir, "Cargo.toml");
  if (!existsSync(manifestPath)) {
    throw new Error(`zcode-score-wasm manifest 缺失: ${manifestPath}`);
  }
  const manifest = readFileSync(manifestPath, "utf8");
  // Only the [lib] table's crate-type matters; scoping avoids a false positive from any other
  // section that happens to mention the key.
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
 * The wasm-bindgen CLI version must match the crate's dependency exactly.
 *
 * The generated glue and the module's custom sections are version-coupled: a CLI older or newer
 * than the `wasm-bindgen` crate dependency produces a mismatch that surfaces as the same opaque
 * `clone_ref` failure. The manifest pins `wasm-bindgen = "=0.2.128"`; this catches a CLI that
 * does not match it before a build is attempted.
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
  // CARGO_TARGET_DIR overrides the default `target/` next to the manifest.
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
  // underscores), not from the package name verbatim: `zcode-scan` -> `libzcode_scan.so`,
  // `zcode-score-wasm` -> `zcode_score_wasm.wasm`.
  const releaseDir = join(targetRoot, WASM_TARGET, "release");
  const artifact = join(releaseDir, "zcode_score_wasm.wasm");
  if (!existsSync(artifact)) {
    // Name what cargo actually produced: a `[lib] name =` override would otherwise surface as a
    // bare "file not found" with no hint at all.
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
 * Run `wasm-bindgen` once per consumer target and stage the payload under its fixed name.
 *
 * The `<out-name>_bg.wasm` payload is copied to `stagedWasm` rather than moved, because the glue
 * emitted next to it is hard-coupled to that exact filename. The copy is the stable, env-overridable
 * name a packaged host can point at; the coupled pair stays intact under `pkg/`.
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
    throw new Error(`zcode-score wasm 暂存失败: ${target.stagedWasm}`);
  }
  return { outDir, stagedBytes: statSync(target.stagedWasm).size };
}

function stage() {
  assertCrateTypeIsCdylibOnly();
  assertWasmTargetInstalled();
  const cliVersion = assertWasmBindgenVersionsMatch();
  const host = hostTargetTriple();

  console.log(`[prepare:zcode-score-wasm] host ${host}, wasm-bindgen CLI ${cliVersion}`);
  const artifact = buildWasmModule();
  for (const target of WASM_BINDGEN_TARGETS) {
    const { outDir, stagedBytes } = stageTarget(artifact, target, cliVersion);
    console.log(
      `[prepare:zcode-score-wasm] staged ${target.key}: ${target.stagedWasm} ` +
        `(${stagedBytes} bytes, glue: ${outDir})`,
    );
  }
}

/**
 * CI gate: prove each staged artifact is present AND loadable.
 *
 * `WebAssembly.validate` alone only proves the bytes are structurally valid wasm — it would happily
 * pass a module that is missing the wasm-bindgen ABI shims and then fails at the first real call. So
 * the nodejs payload additionally goes through its generated glue with an actual trivial call,
 * which is the same "present-but-unloadable must fail here, not at app boot" posture as
 * `prepare-zcode-scan-native.mjs --check`.
 */
function check() {
  for (const target of WASM_BINDGEN_TARGETS) {
    if (!existsSync(target.stagedWasm)) {
      throw new Error(
        `zcode-score wasm 缺失: ${target.stagedWasm}。请先运行 node scripts/prepare-zcode-score-wasm.mjs`,
      );
    }
    const bytes = readFileSync(target.stagedWasm);
    if (!WebAssembly.validate(bytes)) {
      throw new Error(`zcode-score wasm 结构非法(WebAssembly.validate 失败): ${target.stagedWasm}`);
    }
  }

  const gluePath = join(pkgDir, "nodejs", "zcode_score.js");
  if (!existsSync(gluePath)) {
    throw new Error(
      `nodejs glue 缺失: ${gluePath}。请先运行 node scripts/prepare-zcode-score-wasm.mjs`,
    );
  }
  const score = require(gluePath);
  for (const symbol of ["init_index", "release_index", "top_k"]) {
    if (typeof score[symbol] !== "function") {
      throw new Error(`zcode-score wasm 已加载但缺少导出 ${symbol}: ${gluePath}`);
    }
  }
  // Trivial round-trip: an empty index must build and report 0 rows, then release cleanly. This
  // touches the real linear-memory arena rather than just validating bytes. Both string arguments
  // matter — `init_index(packed, root_path)` is what the glue expects, and passing one leaves
  // `root_path` undefined, which surfaces as an opaque TypeError inside passStringToWasm0.
  const rows = score.init_index("", "");
  if (rows !== 0) throw new Error(`init_index("","") 应返回 0，实际返回 ${rows}`);
  score.release_index();

  for (const target of WASM_BINDGEN_TARGETS) {
    console.log(
      `[prepare:zcode-score-wasm] ${target.key} artifact loads: ${target.stagedWasm} ` +
        `(${statSync(target.stagedWasm).size} bytes)`,
    );
  }
  console.log("[prepare:zcode-score-wasm] nodejs glue exports + trivial call: OK");
}

if (process.argv.includes("--check")) check();
else stage();
