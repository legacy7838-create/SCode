#!/usr/bin/env node
// Baseline freshness check before starting work - the current branch lags behind its own remote end, or (in the case of non-feature branches) lags behind
// origin/main exceeds the threshold and fails directly, preventing analysis, writing tests, and repairing problems that have disappeared on the old architecture.
//
// Background: The local zcode-cua was once 140 commits behind origin/main (the local Skill is still
// 558 lines, the main line has converged to 128 lines), the z-code integration branch was once behind its own remote end by 29 commits, all of which were
// Work started on the old baseline. Run this script before starting any session (the zcode-cua repository uses its python equivalent).
//
// Judgment rules:
//   1) Fall behind own remote tracking branches (any number) → fail: git merge --ff-only <upstream> first.
//   2) ahead==0 and behind origin/main exceeds the threshold → Failure: the local main class branch is purely out of date.
//   3) ahead>0 (feature/MR branch) and behind origin/main beyond threshold → warning does not fail: forking is normal,
//      But the number will be printed, and it’s up to you to decide whether to rebase (don’t blindly rebase when there are unmerged draft changes).
//
// Usage: node scripts/check-workspace-freshness.mjs [--max-behind-main 50] [--no-fetch]

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const maxBehindMainIndex = args.indexOf("--max-behind-main");
const maxBehindMain = maxBehindMainIndex >= 0 ? Number(args[maxBehindMainIndex + 1]) : 50;
if (!Number.isInteger(maxBehindMain) || maxBehindMain < 0) {
  console.error("[freshness] --max-behind-main requires a non-negative integer");
  process.exit(2);
}
const doFetch = !args.includes("--no-fetch");

async function git(...gitArgs) {
  const { stdout } = await execFile("git", gitArgs, { encoding: "utf8" });
  return stdout.trim();
}

if (doFetch) {
  await git("fetch", "origin", "--prune");
}

const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
let upstream = null;
try {
  upstream = await git("rev-parse", "--abbrev-ref", "@{upstream}");
} catch {
  console.warn(
    `[freshness] ${branch} has no remote tracking branch, skips behind-remote checks (did you forget push -u?)`,
  );
}

const failures = [];
if (upstream) {
  const behindRemote = Number(await git("rev-list", "--count", `HEAD..${upstream}`));
  if (behindRemote > 0) {
    failures.push(
      `${branch} is behind ${upstream} ${behindRemote} commits: first git merge --ff-only ${upstream}`,
    );
  }
}

let mainReport = "";
try {
  await git("rev-parse", "--verify", "origin/main^{commit}");
  const aheadMain = Number(await git("rev-list", "--count", `origin/main..HEAD`));
  const behindMain = Number(await git("rev-list", "--count", `HEAD..origin/main`));
  mainReport = `Relative to origin/main: ahead ${aheadMain} / behind ${behindMain} (threshold ${maxBehindMain})`;
  if (behindMain > maxBehindMain) {
    const message = `Behind origin/main ${behindMain} commits, exceeds threshold ${maxBehindMain}`;
    if (aheadMain === 0) {
      failures.push(`${message}: git merge --ff-only origin/main or rebuild the branch`);
    } else {
      console.warn(
        `[freshness] Warning: ${message}. This is the feature/MR branch (ahead ${aheadMain}),` +
          `The fork itself is normal; if you want to align with the main line, please confirm the MR status first (do not blindly rebase when there are unmerged draft changes).`,
      );
    }
  }
} catch {
  console.warn(
    "[freshness] The warehouse does not have origin/main, and the main distance check is skipped.",
  );
}

if (failures.length > 0) {
  console.error(
    `[freshness] The baseline has expired and work on the old architecture is refused (current branch: ${branch}):`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `[freshness] Baseline freshness: ${branch}${upstream ? `(with ${upstream} synced)` : ""}${
    mainReport ? `, ${mainReport}` : ""
  }`,
);
