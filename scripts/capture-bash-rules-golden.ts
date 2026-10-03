/**
 * PHASE 3 oracle: capture the bash permission rule matcher.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 3).
 *
 * `evaluateBashRules` decides whether a user's permission rule (allow / deny / ask) matches
 * a command. It is the permission decision itself: drift here means a rule matches when it
 * should not, and an `allow` pattern then lets a destructive command through without asking.
 *
 * Run: pnpm exec tsx scripts/capture-bash-rules-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import { evaluateBashRules } from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-command-rule-evaluator.ts";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

interface Case {
  name: string;
  allSubjectGroups: string[][];
  behavior: "allow" | "deny" | "ask";
  exactCommands: string[];
  requiredSubjectGroups: string[][];
  rules: { toolName: string; ruleContent?: string }[];
  safe: boolean;
}

const CASES: Case[] = [
  // A rule with no content is a catch-all for its tool.
  { name: "empty_rule_content_is_catch_all",
    allSubjectGroups: [["bash"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["bash"]], rules: [{ toolName: "bash" }], safe: false },
  // An exact command hit short-circuits to true regardless of `safe`.
  { name: "exact_command_hit",
    allSubjectGroups: [["git status"]], behavior: "allow", exactCommands: ["git status"],
    requiredSubjectGroups: [["git status"]], rules: [{ toolName: "bash", ruleContent: "git status" }], safe: false },
  { name: "exact_command_hit_with_safe_rule",
    allSubjectGroups: [["bash"]], behavior: "deny", exactCommands: ["git status"],
    requiredSubjectGroups: [["bash"]], rules: [{ toolName: "bash", ruleContent: "git status" }], safe: true },
  // Not safe and no exact hit: deny.
  { name: "unsafe_without_match_rejected",
    allSubjectGroups: [["bash", "rm -rf /"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["bash", "rm -rf /"]], rules: [{ toolName: "bash", ruleContent: "git status" }], safe: false },
  { name: "safe_without_match_rejected",
    allSubjectGroups: [["bash", "git log"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["bash", "git log"]], rules: [{ toolName: "bash", ruleContent: "rm -rf /" }], safe: true },

  // allow: EVERY group must have a matching subject.
  { name: "allow_every_group_matches",
    allSubjectGroups: [["git status", "git log"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["git status"], ["git log"]],
    rules: [{ toolName: "bash", ruleContent: "git *" }], safe: true },
  { name: "allow_one_group_unmatched_rejected",
    allSubjectGroups: [["git status"], ["rm -rf /"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["git status"], ["rm -rf /"]],
    rules: [{ toolName: "bash", ruleContent: "git *" }], safe: true },
  { name: "allow_no_required_groups_rejected",
    allSubjectGroups: [["git status"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [], rules: [{ toolName: "bash", ruleContent: "git *" }], safe: true },

  // deny/ask: ANY group having a match is enough (the alternative resolves differently).
  { name: "deny_one_group_matches",
    allSubjectGroups: [["git status"], ["rm -rf /"]], behavior: "deny", exactCommands: [],
    requiredSubjectGroups: [],
    rules: [{ toolName: "bash", ruleContent: "rm -rf /" }], safe: true },
  { name: "deny_nothing_matches_rejected",
    allSubjectGroups: [["git status"]], behavior: "ask", exactCommands: [],
    requiredSubjectGroups: [],
    rules: [{ toolName: "bash", ruleContent: "rm -rf /" }], safe: true },
  { name: "deny_empty_subject_groups",
    allSubjectGroups: [], behavior: "deny", exactCommands: [],
    requiredSubjectGroups: [],
    rules: [{ toolName: "bash", ruleContent: "rm -rf /" }], safe: true },

  // Rule-content shapes.
  { name: "colon_star_prefix_match",
    allSubjectGroups: [["git status", "git remote -v"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["git status"]],
    rules: [{ toolName: "bash", ruleContent: "git:*" }], safe: true },
  { name: "colon_star_prefix_word_boundary",
    allSubjectGroups: [["git status"], ["gitx status"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["git status"]],
    rules: [{ toolName: "bash", ruleContent: "git:*" }], safe: true },
  { name: "wildcard_match",
    allSubjectGroups: [["npm run build"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["npm run build"]],
    rules: [{ toolName: "bash", ruleContent: "npm run *" }], safe: true },
  { name: "wildcard_no_match",
    allSubjectGroups: [["npm publish"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["npm publish"]],
    rules: [{ toolName: "bash", ruleContent: "npm run *" }], safe: true },
  { name: "wildcard_regex_metachars_escaped",
    allSubjectGroups: [["cat a+b.txt"], ["cat aXb.txt"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["cat a+b.txt"]],
    rules: [{ toolName: "bash", ruleContent: "cat a+b.txt" }], safe: true },
  { name: "exact_literal_match",
    allSubjectGroups: [["rm -rf /tmp/x"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["rm -rf /tmp/x"]],
    rules: [{ toolName: "bash", ruleContent: "rm -rf /tmp/x" }], safe: true },
  { name: "exact_literal_partial_rejected",
    allSubjectGroups: [["rm -rf /tmp/x"]], behavior: "allow", exactCommands: [],
    requiredSubjectGroups: [["rm -rf /tmp/x"]],
    rules: [{ toolName: "bash", ruleContent: "rm -rf" }], safe: true },
];

const results: Record<string, boolean> = {};
for (const testCase of CASES) {
  results[testCase.name] = evaluateBashRules({
    allSubjectGroups: testCase.allSubjectGroups,
    behavior: testCase.behavior,
    exactCommands: testCase.exactCommands,
    requiredSubjectGroups: testCase.requiredSubjectGroups,
    rules: testCase.rules,
    safe: testCase.safe,
  });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/bash-rules-golden.json`, JSON.stringify({ cases: CASES, verdicts: results }, null, 2) + "\n");
const yes = Object.values(results).filter(Boolean).length;
console.log(`captured ${CASES.length} rule-matcher cases (${yes} true, ${CASES.length - yes} false)`);
for (const [name, verdict] of Object.entries(results)) console.log(`  ${verdict ? "TRUE " : "FALSE"} ${name}`);
