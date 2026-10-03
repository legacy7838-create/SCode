/**
 * PHASE 3 oracle: capture the read-only argv flag policy walker.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 3).
 *
 * `isArgvAllowedByPolicy` decides whether the flags on an otherwise-known command are all
 * safe. It is the second half of the safety story after the git global-option gate: get it
 * wrong in the permissive direction and a write flag (`git log --output=/etc/x`, `curl -o`)
 * rides through on a read-only command.
 *
 * Every branch of the walker gets a case: `--`, compact counts, attached short values,
 * clusters, inline `=` values, and each `SafeFlagValue` kind.
 *
 * Run: pnpm exec tsx scripts/capture-argv-flag-policy-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import { isArgvAllowedByPolicy } from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv-flags.ts";
import type { BashReadonlyCommandPolicy } from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-types.js";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

/** Policies chosen to exercise every branch of the walker. */
const POLICIES: Record<string, BashReadonlyCommandPolicy> = {
  allowAny: { allowAnyArgs: true },
  commandOnly: { commandOnly: true },
  // A small, realistic table: this is what a real subcommand carries.
  gitLog: { safeFlags: { "--oneline": "none", "--graph": "none", "-n": "string", "--since": "string", "--max-count": "number" } },
  compactCount: { safeFlags: { "-n": "number" }, allowCompactNumericCountFlag: true },
  headTail: { safeFlags: {} },
  noDoubleDash: { safeFlags: { "--": "none" }, respectsDoubleDash: false },
  xargs: { safeFlags: { "-n": "string", "-0": "none", "-I": "string" } },
  valueKinds: {
    safeFlags: {
      "--num": "number",
      "--ch": "char",
      "--braces": "{}",
      "--eof": "EOF",
      "--opt": "optionalString",
      "--any": "string",
      "--bare": "none",
    },
  },
};

interface Case {
  name: string;
  policy: keyof typeof POLICIES;
  commandName: string;
  argv: string[];
  startIndex?: number;
}

const CASES: Case[] = [
  { name: "allow_any_permits_everything", policy: "allowAny", commandName: "anything", argv: ["anything", "--whatever", "-x", "rm -rf"] },
  { name: "allow_any_on_empty_argv", policy: "allowAny", commandName: "anything", argv: [] },
  { name: "command_only_rejects_arguments", policy: "commandOnly", commandName: "git", argv: ["git", "status"] },
  { name: "command_only_accepts_bare", policy: "commandOnly", commandName: "git", argv: ["git"] },
  { name: "command_only_empty_argv", policy: "commandOnly", commandName: "git", argv: [] },

  { name: "git_log_clean", policy: "gitLog", commandName: "git", argv: ["git", "--oneline", "--graph"] },
  { name: "git_log_with_string_value", policy: "gitLog", commandName: "git", argv: ["git", "--since", "yesterday"] },
  { name: "git_log_with_inline_value", policy: "gitLog", commandName: "git", argv: ["git", "--since=yesterday"] },
  { name: "git_log_string_value_missing", policy: "gitLog", commandName: "git", argv: ["git", "--since"] },
  { name: "git_log_number_value", policy: "gitLog", commandName: "git", argv: ["git", "--max-count", "10"] },
  { name: "git_log_number_value_wrong_kind", policy: "gitLog", commandName: "git", argv: ["git", "--max-count", "ten"] },
  { name: "git_log_unknown_flag_rejected", policy: "gitLog", commandName: "git", argv: ["git", "--output=/etc/passwd"] },
  { name: "git_log_unknown_flag_at_command", policy: "gitLog", commandName: "git", argv: ["git", "log", "--force"] },
  { name: "git_log_none_flag_with_inline_value", policy: "gitLog", commandName: "git", argv: ["git", "--oneline=x"] },
  { name: "git_log_positional_is_skipped", policy: "gitLog", commandName: "git", argv: ["git", "HEAD", "--oneline"], startIndex: 2 },
  { name: "git_log_option_like_string_value", policy: "gitLog", commandName: "git", argv: ["git", "--since", "--not-a-date"] },
  { name: "git_log_double_dash_stops", policy: "gitLog", commandName: "git", argv: ["git", "--", "--oneline"] },

  { name: "compact_count_allowed", policy: "compactCount", commandName: "wc", argv: ["wc", "-10"] },
  { name: "compact_count_not_declared", policy: "gitLog", commandName: "wc", argv: ["wc", "-10"] },
  { name: "head_compact_count_always", policy: "headTail", commandName: "head", argv: ["head", "-20"] },
  { name: "head_compact_count_negative", policy: "headTail", commandName: "head", argv: ["head", "--20"] },
  { name: "tail_compact_count", policy: "headTail", commandName: "tail", argv: ["tail", "-5"] },

  { name: "double_dash_respected", policy: "noDoubleDash", commandName: "sort", argv: ["sort", "--", "file"] },
  { name: "unknown_flag_after_double_dash_ignored", policy: "gitLog", commandName: "git", argv: ["git", "--", "--output=/x"] },

  { name: "xargs_safe_target", policy: "xargs", commandName: "xargs", argv: ["xargs", "grep", "pattern"] },
  { name: "xargs_dangerous_target", policy: "xargs", commandName: "xargs", argv: ["xargs", "rm", "-rf"] },
  { name: "xargs_double_dash_target", policy: "xargs", commandName: "xargs", argv: ["xargs", "--", "echo", "hi"] },
  { name: "xargs_flags_only_accepted", policy: "xargs", commandName: "xargs", argv: ["xargs", "-n", "1", "echo"] },
  { name: "xargs_no_target", policy: "xargs", commandName: "xargs", argv: ["xargs", "-n", "1"] },

  { name: "kind_number_ok", policy: "valueKinds", commandName: "k", argv: ["k", "--num", "42"] },
  { name: "kind_char_ok", policy: "valueKinds", commandName: "k", argv: ["k", "--ch", "x"] },
  { name: "kind_char_too_long", policy: "valueKinds", commandName: "k", argv: ["k", "--ch", "xy"] },
  { name: "kind_braces_ok", policy: "valueKinds", commandName: "k", argv: ["k", "--braces", "{}"] },
  { name: "kind_braces_wrong", policy: "valueKinds", commandName: "k", argv: ["k", "--braces", "x"] },
  { name: "kind_eof_ok", policy: "valueKinds", commandName: "k", argv: ["k", "--eof", "EOF"] },
  { name: "kind_eof_wrong", policy: "valueKinds", commandName: "k", argv: ["k", "--eof", "END"] },
  { name: "kind_optional_string", policy: "valueKinds", commandName: "k", argv: ["k", "--opt", "anything"] },
  { name: "kind_string_any", policy: "valueKinds", commandName: "k", argv: ["k", "--any", "--weird"] },
  { name: "short_attached_value", policy: "valueKinds", commandName: "k", argv: ["k", "--chx"] },
  { name: "short_cluster_all_none", policy: "valueKinds", commandName: "k", argv: ["k", "-abc"] },
  { name: "short_cluster_with_value_flag", policy: "valueKinds", commandName: "k", argv: ["k", "-ac", "x"] },
  { name: "single_dash_is_not_a_flag", policy: "valueKinds", commandName: "k", argv: ["k", "-"] },
];

// The full case travels WITH the expected result, so the Rust test never re-declares the
// fixtures: a second copy of the inputs could drift from the capture and the test would
// still pass against a stale expectation.
const results: Record<string, { allowed: boolean; case: Case; policy: BashReadonlyCommandPolicy }> = {};
for (const testCase of CASES) {
  results[testCase.name] = {
    allowed: isArgvAllowedByPolicy(
      testCase.argv,
      POLICIES[testCase.policy],
      testCase.commandName,
      testCase.startIndex ?? 1,
    ),
    case: testCase,
    policy: POLICIES[testCase.policy],
  };
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/argv-flag-policy-golden.json`, JSON.stringify(results, null, 2) + "\n");
const allowed = Object.values(results).filter(Boolean).length;
console.log(`captured ${CASES.length} flag-policy cases (${allowed} allowed, ${CASES.length - allowed} rejected)`);
for (const [name, ok] of Object.entries(results)) {
  if (!ok) console.log(`  rejected  ${name}`);
}
