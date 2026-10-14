// A6 group: `.zcodeignore` load branches, end-to-end through the REAL production loader.
//
// A3/A4 (in `fixture_scan.mts`) feed the addon a literal rule string. A6 instead drives
// `loadWorkspaceFileSearchIgnoreRules` — the production entry point — so it proves the `content`
// string that the ignore-loader slice added to all four branches actually reaches Rust INTACT.
// That cross-boundary agreement (JS matcher vs Rust prune) is the load-bearing assert; `source`
// and non-empty `content` are secondary.
//
// Every case seeds a realistic tree (`node_modules/x.js` plus an ordinary `src.js`) so "pruned" is
// distinguishable from "the whole scan silently returned nothing" — that is what keeps the parity
// check from passing vacuously.
//
// Split out of `fixture_scan.mts` purely for the repo's `max-lines: 400` budget; not a separate
// concern.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadWorkspaceFileSearchIgnoreRules } from "../../../services/src/file/workspaceFileIgnore.ts";

/** The production loader takes a ServiceLogger; A6 only cares about the returned rules. */
type IgnoreLogger = Parameters<typeof loadWorkspaceFileSearchIgnoreRules>[1];

// The warn/info calls fire for real on the fallback branches — we just drop them, keeping the
// harness output to pass/fail lines only.
const silentLogger = { info: () => {}, warn: () => {} } as unknown as IgnoreLogger;

/** Minimal addon surface A6 needs (the real `.node` is injected by the caller). */
export interface ScanAddonLike {
  scanWorkspaceFilesPacked(rootPath: string, ignoreRuleText: string, locale: string): string;
}

/** Per-scenario outcome; structurally compatible with the A3/A4 result shape in `fixture_scan.mts`. */
export interface BranchResult {
  id: string;
  title: string;
  ok: boolean;
  details: string[];
}

interface A6Scenario {
  id: string;
  title: string;
  /** Pre-seed `.zcodeignore` verbatim, if any. */
  zcodeignore?: string;
  /** Pre-seed `.gitignore` verbatim, if any. */
  gitignore?: string;
  /** When set, chmod the root dir to this mode before loading, forcing the fallback (EACCES) path. */
  chmod?: number;
  expectSource: string;
  /** Content must contain this substring (e.g. the rule the scenario is supposed to carry). */
  expectContentIncludes?: string;
}

const A6_SCENARIOS: A6Scenario[] = [
  {
    id: "A6-1",
    title: ".zcodeignore exists -> source=file",
    zcodeignore: "node_modules/\n!keep.log\n*.tmp\n",
    expectSource: "file",
    expectContentIncludes: "node_modules/",
  },
  {
    id: "A6-2",
    title: "no .zcodeignore, .gitignore present -> source=created-from-gitignore",
    gitignore: "node_modules/\ndist/\n*.log\n",
    expectSource: "created-from-gitignore",
    expectContentIncludes: "node_modules/",
  },
  {
    id: "A6-3",
    title: "neither present -> source=created-from-template (BUILTIN default rules end-to-end)",
    expectSource: "created-from-template",
    expectContentIncludes: "node_modules/",
  },
  {
    id: "A6-4a",
    title: "write throws (EACCES), .gitignore present -> source=fallback-gitignore",
    gitignore: "node_modules/\ndist/\n",
    chmod: 0o555,
    expectSource: "fallback-gitignore",
    expectContentIncludes: "node_modules/",
  },
  {
    id: "A6-4b",
    title: "write throws (EACCES), no .gitignore -> source=fallback-builtin",
    chmod: 0o555,
    expectSource: "fallback-builtin",
    expectContentIncludes: "node_modules/",
  },
];

async function runA6Scenario(
  scenario: A6Scenario,
  addon: ScanAddonLike,
  locale: string,
): Promise<BranchResult> {
  const details: string[] = [];
  const root = mkdtempSync(join(tmpdir(), `zcode-scan-${scenario.id}-`));
  try {
    if (scenario.zcodeignore !== undefined)
      writeFileSync(join(root, ".zcodeignore"), scenario.zcodeignore);
    if (scenario.gitignore !== undefined)
      writeFileSync(join(root, ".gitignore"), scenario.gitignore);
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x.js"), "");
    writeFileSync(join(root, "src.js"), "");
    if (scenario.chmod !== undefined) chmodSync(root, scenario.chmod);

    const rules = await loadWorkspaceFileSearchIgnoreRules(root, silentLogger);
    const packed = addon.scanWorkspaceFilesPacked(root, rules.content, locale);

    // (1) PRIMARY: JS matcher vs Rust prune must agree — proves `content` reaches Rust intact.
    const jsIgnores = rules.matcher.ignores("node_modules/x.js");
    const rustPrunes = !packed.includes("node_modules/x.js");
    if (jsIgnores !== rustPrunes) {
      details.push(`JS/Rust disagree on node_modules/x.js: JS=${jsIgnores} RUST=${rustPrunes}`);
    }
    if (jsIgnores !== true)
      details.push(`expected JS matcher to ignore node_modules/x.js, got ${jsIgnores}`);
    if (!packed.includes("src.js")) details.push("rust scan dropped the ordinary file src.js");

    // (2) source field.
    if (rules.source !== scenario.expectSource) {
      details.push(`expected source=${scenario.expectSource}, got source=${rules.source}`);
    }
    // (3) content non-empty (+ carries the scenario's rule).
    if (rules.content.length === 0) details.push("content is empty");
    if (
      scenario.expectContentIncludes !== undefined &&
      !rules.content.includes(scenario.expectContentIncludes)
    ) {
      details.push(`content does not contain expected rule ${scenario.expectContentIncludes}`);
    }

    return { id: scenario.id, title: scenario.title, ok: details.length === 0, details };
  } finally {
    // Restore write perms before rm, or cleanup of an EACCES dir leaves temp litter behind.
    if (scenario.chmod !== undefined) {
      try {
        chmodSync(root, 0o755);
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run every `.zcodeignore` load-branch scenario; returns one result per scenario. */
export async function runA6BranchScenarios(
  addon: ScanAddonLike,
  locale: string,
): Promise<BranchResult[]> {
  const results: BranchResult[] = [];
  for (const scenario of A6_SCENARIOS) results.push(await runA6Scenario(scenario, addon, locale));
  return results;
}
