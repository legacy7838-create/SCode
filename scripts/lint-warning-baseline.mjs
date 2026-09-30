#!/usr/bin/env node
/**
 * Lint-warning attribution helper.
 *
 * Why this exists (bug fix 说明):
 *   `git stash -u` was used to produce a "baseline" warning count and the result was
 *   compared against the working tree. That comparison is meaningless in this repo:
 *   the tree routinely carries thousands of pre-existing uncommitted modifications, and
 *   `git stash -u` reverts *all* of them, so the "baseline" is a different codebase rather
 *   than the same codebase minus the author's work. A measured difference of a few warnings
 *   was then attributed to the author's patch even though it came from unrelated pending work.
 *
 * What this does instead:
 *   It reports (a) the total warning count, and (b) how many warnings come from the files the
 *   author actually touched, computed from the working-tree diff against a ref — no stashing,
 *   so no pre-existing work is ever moved or lost. Untracked files are included, because
 *   newly added files are exactly the ones an author is responsible for.
 *
 * Usage:
 *   node scripts/lint-warning-baseline.mjs                 # attribute against HEAD
 *   node scripts/lint-warning-baseline.mjs --base main     # attribute against another ref
 *   node scripts/lint-warning-baseline.mjs --changed-only  # lint only the author's files
 */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : "HEAD";
const changedOnly = args.includes("--changed-only");

async function git(...gitArgs) {
  const { stdout } = await execFile("git", gitArgs, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Tracked files that differ from <base> (modified, added, deleted, renamed). */
async function changedTrackedFiles() {
  const out = await git("diff", "--name-only", "--diff-filter=ACMR", base);
  return out.split("\n").filter(Boolean);
}

/** Untracked files, excluding gitignored paths. */
async function untrackedFiles() {
  const out = await git("ls-files", "--others", "--exclude-standard");
  return out.split("\n").filter(Boolean);
}

/** Parse "Found N warnings and M errors." from oxlint output. */
function parseTotals(output) {
  const match = output.match(/Found (\d+) warnings? and (\d+) errors?/);
  if (!match) return null;
  return { warnings: Number(match[1]), errors: Number(match[2]) };
}

async function runOxlint(targets) {
  // oxlint exits non-zero when it finds errors; warnings alone do not fail the lint gate.
  try {
    const { stdout, stderr } = await execFile("npx", ["oxlint", ...targets], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout + stderr;
  } catch (error) {
    return (error.stdout ?? "") + (error.stderr ?? "");
  }
}

/** Split paths into argv-safe batches (the OS rejects a single very long argument list). */
function batchPaths(paths, size = 200) {
  const batches = [];
  for (let index = 0; index < paths.length; index += size) {
    batches.push(paths.slice(index, index + size));
  }
  return batches;
}

const tracked = await changedTrackedFiles();
const untracked = await untrackedFiles();
const mine = [...new Set([...tracked, ...untracked])];

const totalsOutput = await runOxlint([]);
const totals = parseTotals(totalsOutput);

console.log(
  `repo total: ${totals ? `${totals.warnings} warnings, ${totals.errors} errors` : "unparsed"}`,
);
console.log(
  `author files: ${mine.length} (${tracked.length} changed vs ${base}, ${untracked.length} untracked)`,
);

if (mine.length === 0) {
  console.log("author-attributed warnings: 0 (no changed or untracked files)");
  process.exit(0);
}

if (changedOnly) {
  // Passing thousands of paths to one invocation exceeds the OS argv limit, so lint in batches
  // and sum the per-batch totals instead.
  let scopedWarnings = 0;
  let scopedErrors = 0;
  const details = [];
  for (const batch of batchPaths(mine)) {
    const output = await runOxlint(batch);
    const parsed = parseTotals(output);
    if (parsed) {
      scopedWarnings += parsed.warnings;
      scopedErrors += parsed.errors;
    } else {
      details.push(output.trim());
    }
  }
  console.log(`author-attributed: ${scopedWarnings} warnings, ${scopedErrors} errors`);
  if (details.length > 0) {
    console.log("\n--- unparsed output ---");
    console.log(details.join("\n"));
  }
  process.exit(0);
}

// Attribute per file so a warning is only blamed on the author when the file is theirs.
let authored = 0;
const perFile = [];
for (const file of mine) {
  const output = await runOxlint([file]);
  const parsed = parseTotals(output);
  if (parsed && parsed.warnings > 0) {
    authored += parsed.warnings;
    perFile.push(`${parsed.warnings}\t${file}`);
  }
}

console.log(`author-attributed warnings: ${authored}`);
if (perFile.length > 0) {
  console.log("\n--- details ---");
  console.log(perFile.join("\n"));
}
console.log(
  `\nnote: only compare against ${base} by re-running this script, never by stashing; ` +
    `the tree may hold uncommitted work that is not yours.`,
);
