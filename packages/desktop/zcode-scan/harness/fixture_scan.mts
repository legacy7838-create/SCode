// Fixture-based acceptance harness for the Rust `zcode-scan` addon: spec §4 scenarios A3 (gitignore
// parity), A4 (file-policy parity), A6 (.zcodeignore load branches), plus the A5 "no JS fallback
// exists" gate.
//
//   node_modules/.bin/tsx packages/desktop/zcode-scan/harness/fixture_scan.mts
//
// The PRIMARY assertion for every case is PARITY against `reference_scan.mts` — the preserved
// pre-port JavaScript walk — not a hand-written expected string. Hardcoding an expected packed
// string would only re-encode this harness author's assumptions; the spec's contract is "Rust
// output == the old JS output". Hardcoded `expect.include`/`expect.exclude` sets are therefore
// limited to the rules the spec states outright (e.g. "build/ prunes a directory but a *file*
// named build is kept"), so a case cannot pass by being trivially empty on both sides.
//
// Each case seeds a FRESH temp tree (mkdtempSync), runs both implementations with identical rule
// text and locale, then: (1) asserts byte-identical packed output, (2) asserts the spec-stated
// include/exclude membership. Exit code is non-zero if any case or any A5 check fails.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { referenceScan } from "./reference_scan.mts";
import { runA6BranchScenarios } from "./a6_ignore_branches.mts";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const crateDir = join(here, "..");
const stagedAddonPath = join(crateDir, "zcode_scan.node");
const addon = require(stagedAddonPath);
const locale = new Intl.Collator().resolvedOptions().locale;

interface Case {
  /** Stable id, e.g. `A3-1`. */
  id: string;
  /** One-line description of the rule under test. */
  title: string;
  /** Verbatim `.zcodeignore` content handed to BOTH implementations. */
  rules: string;
  /** Relative file paths to create; parent dirs are created automatically. */
  files: string[];
  /** Relative directory paths to create empty (for dir-only ignore rules). */
  dirs?: string[];
  /** Spec-stated membership. Only include rules the spec states outright. */
  expect: { include: string[]; exclude: string[] };
}

/** Every fixture file uses these extensions/names so they are never filtered by A4 policy. */
const FIXTURE_FILES = {
  plain: "note.txt",
  tmp: "sample.tmp",
} as const;

const CASES: Case[] = [
  // ---- A3: .zcodeignore / gitignore semantics -----------------------------------------------------
  {
    id: "A3-1",
    title: "trailing `/` is dir-only: `build/` prunes the directory subtree",
    rules: "build/\n",
    files: [join("build", "out.txt"), join("sub", "build", "inner.txt"), FIXTURE_FILES.plain],
    dirs: ["build", join("sub", "build")],
    expect: {
      include: [FIXTURE_FILES.plain],
      exclude: ["build", join("sub", "build"), join("build", "out.txt")],
    },
  },
  {
    id: "A3-1b",
    title: "trailing `/` does NOT match a FILE named `build`",
    rules: "build/\n",
    files: ["build", FIXTURE_FILES.plain],
    expect: { include: ["build", FIXTURE_FILES.plain], exclude: [] },
  },
  {
    id: "A3-1c",
    title: "dir-only rule `logs/` prunes the directory but a FILE named `logs.txt` survives",
    rules: "logs/\n",
    files: ["logs.txt", join("logs", "today.txt"), FIXTURE_FILES.plain],
    dirs: ["logs"],
    expect: {
      include: ["logs.txt", FIXTURE_FILES.plain],
      exclude: ["logs", join("logs", "today.txt")],
    },
  },
  {
    id: "A3-2",
    title: "`!` negation re-includes a previously ignored file",
    rules: "*.log\n!keep.log\n",
    files: ["drop.log", "keep.log", join("nested", "drop.log"), join("nested", "keep.log")],
    expect: {
      include: ["keep.log", join("nested", "keep.log")],
      exclude: ["drop.log", join("nested", "drop.log")],
    },
  },
  {
    id: "A3-3",
    title: "anchored `/rooted.txt` matches only at the workspace root",
    rules: "/rooted.txt\n",
    files: ["rooted.txt", join("sub", "rooted.txt"), join("sub", "deep", "rooted.txt")],
    expect: { include: [join("sub", "rooted.txt")], exclude: ["rooted.txt"] },
  },
  {
    id: "A3-4",
    title: "basename rule `target.txt` matches at any depth",
    rules: "target.txt\n",
    files: ["target.txt", join("a", "target.txt"), join("a", "b", "target.txt")],
    expect: {
      include: [],
      exclude: ["target.txt", join("a", "target.txt"), join("a", "b", "target.txt")],
    },
  },
  {
    id: "A3-5",
    title: "`**/deep.txt` matches across levels",
    rules: "**/deep.txt\n",
    files: ["deep.txt", join("x", "deep.txt"), join("x", "y", "z", "deep.txt")],
    expect: {
      include: [],
      exclude: ["deep.txt", join("x", "deep.txt"), join("x", "y", "z", "deep.txt")],
    },
  },
  {
    id: "A3-6",
    title: "`**` ignores everything",
    rules: "**\n",
    files: ["a.txt", join("a", "b.txt"), join("a", "b", "c.txt")],
    expect: { include: [], exclude: ["a.txt", join("a", "b.txt"), join("a", "b", "c.txt")] },
  },
  {
    id: "A3-6b",
    title: "`**` combined with `!a.txt` re-includes a single file",
    rules: "**\n!a.txt\n",
    files: ["a.txt", join("a", "b.txt")],
    expect: { include: ["a.txt"], exclude: [join("a", "b.txt")] },
  },
  {
    id: "A3-7",
    title: "character class `[ab].tmp`",
    rules: "[ab].tmp\n",
    files: ["a.tmp", "b.tmp", FIXTURE_FILES.tmp, join("sub", "a.tmp")],
    expect: { include: [FIXTURE_FILES.tmp], exclude: ["a.tmp", "b.tmp", join("sub", "a.tmp")] },
  },
  {
    id: "A3-8",
    title: "escaped space `my\\ file.txt`",
    rules: "my\\ file.txt\n",
    files: ["my file.txt", "my file.txt.bak", join("sub", "my file.txt")],
    expect: { include: ["my file.txt.bak"], exclude: ["my file.txt", join("sub", "my file.txt")] },
  },
  {
    id: "A3-9",
    title: "excluded parent cannot re-include child (`excl/` + `!excl/child.txt`)",
    rules: "excl/\n!excl/child.txt\n",
    files: [join("excl", "child.txt"), join("excl", "other.txt"), join("excl", "sub", "child.txt")],
    dirs: ["excl", join("excl", "sub")],
    expect: {
      include: [],
      exclude: [
        join("excl", "child.txt"),
        join("excl", "other.txt"),
        join("excl", "sub", "child.txt"),
      ],
    },
  },

  // ---- A4: file-level search policy ---------------------------------------------------------------
  {
    id: "A4-1",
    title: "skipped names/extensions excluded; ordinary files included",
    rules: "",
    files: [
      ".env",
      ".env.local",
      "coverage.out",
      "lcov.info",
      "app.exe",
      "lib.dll",
      "mod.node",
      "mod.pyc",
      "README.md",
      join("sub", ".env.local"),
    ],
    expect: {
      include: ["README.md"],
      exclude: [
        ".env",
        ".env.local",
        "coverage.out",
        "lcov.info",
        "app.exe",
        "lib.dll",
        "mod.node",
        "mod.pyc",
        join("sub", ".env.local"),
      ],
    },
  },
  {
    id: "A4-2",
    title: "hidden directory traversed but not listed; its files remain searchable",
    rules: "",
    files: [
      join(".github", "ci.yml"),
      join(".github", "workflows", "release.yml"),
      join("src", "index.ts"),
    ],
    dirs: [join(".github", "workflows")],
    expect: {
      include: [
        join(".github", "ci.yml"),
        join(".github", "workflows", "release.yml"),
        join("src", "index.ts"),
      ],
      exclude: [".github", join(".github", "workflows")],
    },
  },
  {
    id: "A4-3",
    title: "root `.zcodeignore` itself is not a candidate (mirrors the retired JS scan)",
    rules: "",
    files: [".zcodeignore", FIXTURE_FILES.plain],
    expect: { include: [FIXTURE_FILES.plain], exclude: [".zcodeignore"] },
  },
];

// The two implementations pack entries as `${type}\t${relativePath}`; a membership check only needs
// the relativePath set, so parse it out of each line.
function relativePathsOf(packed: string): Set<string> {
  return new Set(
    packed === "" ? [] : packed.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)),
  );
}

interface CaseResult {
  id: string;
  title: string;
  ok: boolean;
  details: string[];
}

async function runCase(testCase: Case): Promise<CaseResult> {
  const root = mkdtempSync(join(tmpdir(), `zcode-scan-${testCase.id}-`));
  const details: string[] = [];
  try {
    for (const dir of testCase.dirs ?? []) mkdirSync(join(root, dir), { recursive: true });
    for (const file of testCase.files) {
      const filePath = join(root, file);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "");
    }

    const reference = await referenceScan(root, testCase.rules, locale);
    const rust = addon.scanWorkspaceFilesPacked(root, testCase.rules, locale);

    // PRIMARY gate: byte-identical packed output vs the retired JS walk.
    if (reference.packed !== rust) {
      details.push(`parity DIFF`);
      details.push(`  reference: ${JSON.stringify(reference.packed)}`);
      details.push(`  rust     : ${JSON.stringify(rust)}`);
    }

    // Spec-stated membership (guards against "both sides agree because both are empty").
    const rustPaths = relativePathsOf(rust);
    for (const expected of testCase.expect.include) {
      if (!rustPaths.has(expected)) details.push(`expected include missing from rust: ${expected}`);
    }
    for (const forbidden of testCase.expect.exclude) {
      if (rustPaths.has(forbidden)) details.push(`expected exclude present in rust: ${forbidden}`);
    }

    return { id: testCase.id, title: testCase.title, ok: details.length === 0, details };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- A5 gate: "no JS fallback exists" ---------------------------------------------------------
//
// Each check is a plain boolean with an explicit pass/fail line. The runtime checks run the real
// loader in a FRESH tsx child process so the parent's `require` cache cannot mask a missing file.

// Loads workspaceScanNative.ts in a child process and reports whether a scan throws or degrades.
function childScanThrows(env: Record<string, string>): { threw: boolean; message: string } {
  const childSource = `
    import { scanWorkspaceFilesPacked } from ${JSON.stringify(join(here, "../../../services/src/file/workspaceScanNative.ts"))};
    try {
      scanWorkspaceFilesPacked({ rootPath: ${JSON.stringify(tmpdir())}, ignoreRuleText: "", locale: "en-US" });
      console.log("RESULT:NO_THROW");
    } catch (error) {
      console.log("RESULT:THREW:" + (error instanceof Error ? error.message : String(error)));
    }
  `;
  const result = spawnSync(
    process.execPath,
    [join(here, "../../../../node_modules/tsx/dist/cli.mjs"), "--eval", childSource],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  const match = /RESULT:(NO_THROW|THREW:[^\n]*)/.exec(result.stdout ?? "");
  if (!match)
    return {
      threw: false,
      message: `child produced no result (status=${result.status}) ${result.stderr ?? ""}`,
    };
  return { threw: match[1].startsWith("THREW"), message: match[1] };
}

interface GateCheck {
  id: string;
  ok: boolean;
  detail: string;
}

function staticScanPathChecks(): GateCheck[] {
  const fileServiceSource = readFileSync(
    join(here, "../../../services/src/file/fileService.ts"),
    "utf8",
  );
  // Scope to the scan body (`ensureWorkspaceFileIndex`), not the whole file: `readdir()` and
  // `resolveReaddirEntryType` legitimately remain for the directory-tree API (spec §5/§6).
  const scanStart = fileServiceSource.indexOf("const ensureWorkspaceFileIndex");
  const scanEnd = fileServiceSource.indexOf("async readdir(", scanStart);
  const scanBody =
    scanStart >= 0 && scanEnd > scanStart ? fileServiceSource.slice(scanStart, scanEnd) : "";

  const whole = fileServiceSource;
  return [
    {
      id: "A5.1",
      ok: scanBody.length > 0,
      detail: "locate ensureWorkspaceFileIndex scan body in fileService.ts",
    },
    {
      id: "A5.2",
      ok: !scanBody.includes("readdir("),
      detail: "scan path contains no readdir(",
    },
    {
      id: "A5.3",
      ok: !whole.includes("packWorkspaceFileEntries"),
      detail: "fileService.ts does not call packWorkspaceFileEntries",
    },
    {
      id: "A5.4",
      ok: !/from\s+["']ignore["']/.test(whole),
      detail: "fileService.ts does not import the `ignore` npm matcher",
    },
    {
      id: "A5.5",
      ok: scanBody.includes("scanWorkspaceFilesPacked("),
      detail: "scan path calls the Rust addon (scanWorkspaceFilesPacked)",
    },
  ];
}

function runtimeNoFallbackChecks(): GateCheck[] {
  const checks: GateCheck[] = [];

  // (1) Present addon scans fine.
  const present = childScanThrows({});
  checks.push({
    id: "A5.6",
    ok: !present.threw,
    detail: present.threw
      ? `addon present but scan threw: ${present.message}`
      : "staged addon scans without throwing",
  });

  // (2) Renaming the staged addon away must make the loader THROW, not degrade. Restored in finally.
  const hiddenPath = `${stagedAddonPath}.a5-hidden`;
  if (existsSync(stagedAddonPath)) {
    renameSync(stagedAddonPath, hiddenPath);
    try {
      const missing = childScanThrows({});
      checks.push({
        id: "A5.7",
        ok: missing.threw,
        detail: missing.threw
          ? `addon absent -> THREW (${missing.message.slice(0, 60)}...)`
          : "addon absent but scan did NOT throw",
      });
    } finally {
      renameSync(hiddenPath, stagedAddonPath);
    }
  } else {
    checks.push({
      id: "A5.7",
      ok: false,
      detail: `staged addon missing before test: ${stagedAddonPath}`,
    });
  }
  checks.push({
    id: "A5.8",
    ok: existsSync(stagedAddonPath),
    detail: "staged addon restored after rename test",
  });

  // (3) A bogus ZCODE_SCAN_NATIVE env path must throw, not silently fall back to the dev path.
  const bogusEnv = childScanThrows({
    ZCODE_SCAN_NATIVE: join(tmpdir(), "definitely-missing.node"),
  });
  checks.push({
    id: "A5.9",
    ok: bogusEnv.threw,
    detail: bogusEnv.threw
      ? "bogus ZCODE_SCAN_NATIVE -> THREW"
      : "bogus ZCODE_SCAN_NATIVE did NOT throw",
  });

  return checks;
}

// ---- runner ------------------------------------------------------------------------------------

console.log(`node ${process.version}  locale ${locale}  addon ${stagedAddonPath}\n`);

let failed = 0;

function report(label: string, results: CaseResult[]): void {
  console.log(label);
  for (const result of results) {
    if (result.ok) {
      console.log(`  OK    ${result.id.padEnd(6)} ${result.title}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${result.id.padEnd(6)} ${result.title}`);
      for (const detail of result.details) console.log(`          ${detail}`);
    }
  }
}

const caseResults: CaseResult[] = [];
for (const testCase of CASES) caseResults.push(await runCase(testCase));
report("A3/A4 fixture parity (Rust addon vs retired JS reference):", caseResults);

const a6Results = await runA6BranchScenarios(addon, locale);
report("\nA6 .zcodeignore load branches (real loader -> JS matcher vs Rust addon):", a6Results);

console.log("\nA5 no-fallback gate:");
const gateChecks = [...staticScanPathChecks(), ...runtimeNoFallbackChecks()];
for (const check of gateChecks) {
  if (check.ok) {
    console.log(`  OK    ${check.id.padEnd(6)} ${check.detail}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${check.id.padEnd(6)} ${check.detail}`);
  }
}

console.log("");
if (failed > 0) {
  console.error(`FIXTURE SCAN: FAILED — ${failed} check(s) failed`);
  process.exit(1);
}
console.log(
  `FIXTURE SCAN: OK — ${caseResults.length} A3/A4 cases + ${a6Results.length} A6 cases + ` +
    `${gateChecks.length} A5 checks passed`,
);
