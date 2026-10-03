/**
 * PHASE 3 oracle: the git subcommand danger callbacks.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 3).
 *
 * These gate the commands the read-only git policy otherwise allows: `git tag` without
 * `--list` can move or delete a tag, `git reflog expire` destroys history, `git log
 * --format=%G` executes a signature check, `git ls-remote` reaches the network. They are the
 * policy table's `additionalCommandIsDangerousCallback` values, so they must move with it.
 *
 * Run: pnpm exec tsx scripts/capture-git-callbacks-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import * as git from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-git-callbacks.ts";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

const CASES: { name: string; call: (args: string[]) => boolean }[] = [
  { name: "revision_format_plain", call: (a) => git.gitRevisionFormatCommandIsDangerous("git", a) },
  { name: "revision_format_signature", call: (a) => git.gitRevisionFormatCommandIsDangerous("git", a) },
  { name: "revision_format_signature_paren", call: (a) => git.gitRevisionFormatCommandIsDangerous("git", a) },
  { name: "revision_format_hash_with_G", call: (a) => git.gitRevisionFormatCommandIsDangerous("git", a) },
  { name: "revision_format_safe_format", call: (a) => git.gitRevisionFormatCommandIsDangerous("git", a) },
  { name: "revision_format_inline", call: (a) => git.gitRevisionFormatCommandIsDangerous("git", a) },
  { name: "revision_format_pretty_inline", call: (a) => git.gitRevisionFormatCommandIsDangerous("git", a) },
  { name: "revision_format_no_value", call: (a) => git.gitRevisionFormatCommandIsDangerous("git", a) },

  { name: "reflog_list", call: (a) => git.gitReflogCommandIsDangerous("git", a) },
  { name: "reflog_show", call: (a) => git.gitReflogCommandIsDangerous("git", a) },
  { name: "reflog_expire", call: (a) => git.gitReflogCommandIsDangerous("git", a) },
  { name: "reflog_delete", call: (a) => git.gitReflogCommandIsDangerous("git", a) },
  { name: "reflog_unknown_subcommand", call: (a) => git.gitReflogCommandIsDangerous("git", a) },
  { name: "reflog_dangerous_later", call: (a) => git.gitReflogCommandIsDangerous("git", a) },

  { name: "ls_remote_flag_only", call: (a) => git.gitLsRemoteCommandIsDangerous("git", a) },
  { name: "ls_remote_no_pattern", call: (a) => git.gitLsRemoteCommandIsDangerous("git", a) },
  { name: "ls_remote_with_pattern", call: (a) => git.gitLsRemoteCommandIsDangerous("git", a) },
  { name: "ls_remote_sort_consumes", call: (a) => git.gitLsRemoteCommandIsDangerous("git", a) },
  { name: "ls_remote_after_double_dash", call: (a) => git.gitLsRemoteCommandIsDangerous("git", a) },

  { name: "remote_show_clean", call: (a) => git.gitRemoteShowCommandIsDangerous("git", a) },
  { name: "remote_show_without_n", call: (a) => git.gitRemoteShowCommandIsDangerous("git", a) },
  { name: "remote_show_two_positionals", call: (a) => git.gitRemoteShowCommandIsDangerous("git", a) },
  { name: "remote_show_bad_name", call: (a) => git.gitRemoteShowCommandIsDangerous("git", a) },
  { name: "remote_show_double_dash_name", call: (a) => git.gitRemoteShowCommandIsDangerous("git", a) },

  { name: "tag_without_list", call: (a) => git.gitTagCommandIsDangerous("git", a) },
  { name: "tag_with_list", call: (a) => git.gitTagCommandIsDangerous("git", a) },
  { name: "tag_short_list", call: (a) => git.gitTagCommandIsDangerous("git", a) },
  { name: "tag_with_merged", call: (a) => git.gitTagCommandIsDangerous("git", a) },
  { name: "tag_with_no_merged", call: (a) => git.gitTagCommandIsDangerous("git", a) },
  { name: "tag_points_at_is_a_value_flag", call: (a) => git.gitTagCommandIsDangerous("git", a) },
  { name: "tag_after_double_dash", call: (a) => git.gitTagCommandIsDangerous("git", a) },

  { name: "branch_without_list", call: (a) => git.gitBranchCommandIsDangerous("git", a) },
  { name: "branch_with_list", call: (a) => git.gitBranchCommandIsDangerous("git", a) },
  { name: "branch_with_merged_is_not_a_branch_value_flag", call: (a) => git.gitBranchCommandIsDangerous("git", a) },
  { name: "branch_contains_consumes", call: (a) => git.gitBranchCommandIsDangerous("git", a) },
  { name: "branch_cluster_list", call: (a) => git.gitBranchCommandIsDangerous("git", a) },
];

const ARGV: Record<string, string[]> = {
  revision_format_plain: ["--format=%H", "HEAD"],
  revision_format_signature: ["--format=%G", "HEAD"],
  revision_format_signature_paren: ["--format=%(*signature)", "HEAD"],
  revision_format_hash_with_G: ["--pretty=%G"],
  revision_format_safe_format: ["--format=%h %s", "HEAD"],
  revision_format_inline: ["--pretty=%G"],
  revision_format_pretty_inline: ["--pretty=oneline"],
  revision_format_no_value: ["--format"],

  reflog_list: ["list"],
  reflog_show: ["show", "HEAD"],
  reflog_expire: ["expire"],
  reflog_delete: ["delete"],
  reflog_unknown_subcommand: ["frobnicate"],
  reflog_dangerous_later: ["show", "expire"],

  ls_remote_flag_only: ["--heads"],
  ls_remote_no_pattern: [],
  ls_remote_with_pattern: ["origin"],
  ls_remote_sort_consumes: ["--sort", "refname", "origin"],
  ls_remote_after_double_dash: ["--", "origin"],

  remote_show_clean: ["-n", "origin"],
  remote_show_without_n: ["origin"],
  remote_show_two_positionals: ["-n", "origin", "extra"],
  remote_show_bad_name: ["-n", "-bad name"],
  remote_show_double_dash_name: ["-n", "--", "origin"],

  tag_without_list: ["v1.0"],
  tag_with_list: ["--list"],
  tag_short_list: ["-l"],
  tag_with_merged: ["--merged", "main"],
  tag_with_no_merged: ["--no-merged", "main"],
  tag_points_at_is_a_value_flag: ["--points-at", "abc"],
  tag_after_double_dash: ["--", "v1.0"],

  branch_without_list: ["main"],
  branch_with_list: ["--list"],
  branch_with_merged_is_not_a_branch_value_flag: ["--merged", "main"],
  branch_contains_consumes: ["--contains", "abc"],
  branch_cluster_list: ["-al"],
};

const results: Record<string, { dangerous: boolean; args: string[] }> = {};
for (const testCase of CASES) {
  results[testCase.name] = {
    dangerous: testCase.call(ARGV[testCase.name] ?? []),
    args: ARGV[testCase.name] ?? [],
  };
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/git-callbacks-golden.json`, JSON.stringify(results, null, 2) + "\n");
const dangerous = Object.values(results).filter((entry) => entry.dangerous).length;
console.log(`captured ${CASES.length} git-callback cases (${dangerous} dangerous, ${CASES.length - dangerous} clean)`);
for (const [name, entry] of Object.entries(results)) {
  if (entry.dangerous) console.log(`  DANGEROUS  ${name}`);
}
