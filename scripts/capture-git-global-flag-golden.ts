/**
 * PHASE 3 oracle: capture the git global-option safety gate.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 3).
 *
 * `hasDangerousGitGlobalOption` is the FIRST line of defence in the read-only git
 * classifier, and it is a security boundary: `git -c core.pager=<command>` or
 * `git --exec-path=...` runs an arbitrary command while every later policy check still
 * sees only "git <subcommand>". If this predicate drifts, a destructive command can be
 * classified read-only and run without asking.
 *
 * Run: pnpm exec tsx scripts/capture-git-global-flag-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import {
  GIT_GLOBAL_DANGEROUS_FLAGS,
  GIT_GLOBAL_NO_VALUE_FLAGS,
} from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-simple-commands.ts";
import { hasDangerousGitGlobalOption } from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv-git.ts";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

const ARGV_CASES: string[][] = [
  ["git", "status"],
  ["git", "--no-pager", "status"],
  ["git", "--paginate", "log"],
  // The dangerous set, long form.
  ["git", "-c", "core.pager=sh", "log"],
  ["git", "--config-env", "A=B", "log"],
  ["git", "--exec-path=/tmp/evil", "log"],
  ["git", "--git-dir=/elsewhere/.git", "status"],
  ["git", "--work-tree", "/elsewhere", "status"],
  ["git", "--namespace=ns", "status"],
  ["git", "--attr-source=tree", "status"],
  ["git", "--shallow-file=/tmp/f", "log"],
  ["git", "--super-prefix=/x", "status"],
  ["git", "--bare", "status"],
  // Attached short options: the ones that take a value glued on.
  ["git", "-C/tmp/evil", "status"],
  ["git", "-cfoo=bar", "log"],
  ["git", "-C", "/tmp/evil", "status"],
  // Not dangerous: a bare short flag, or a value-looking word.
  ["git", "-v", "log"],
  ["git", "-", "status"],
  ["git", "--", "status"],
  ["git", "log", "--oneline"],
  ["git", "--no-pager", "--oneline", "log"],
  // Attached short option that is NOT in the dangerous set.
  ["git", "-fsomething", "log"],
  // A word that merely starts with a dangerous flag name but is a different flag.
  ["git", "--color", "log"],
  ["git", "--config", "log"],
  // An empty word, which the caller skips in normalizeGitArgv.
  ["git", ""],
  ["git"],
];

const results: Record<string, boolean> = {};
for (const argv of ARGV_CASES) {
  results[JSON.stringify(argv)] = hasDangerousGitGlobalOption(argv);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/git-global-flag-golden.json`, JSON.stringify(results, null, 2) + "\n");
const dangerous = Object.values(results).filter(Boolean).length;
console.log(`captured ${ARGV_CASES.length} argv cases (${dangerous} dangerous, ${ARGV_CASES.length - dangerous} safe)`);
console.log(`tables: ${GIT_GLOBAL_DANGEROUS_FLAGS.size} dangerous flags, ${GIT_GLOBAL_NO_VALUE_FLAGS.size} no-value flags`);
for (const [argv, isDangerous] of Object.entries(results)) {
  if (isDangerous) console.log(`  DANGEROUS  ${argv}`);
}
