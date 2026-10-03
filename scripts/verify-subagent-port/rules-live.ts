/** Verification section: rules-live. See docs/specs/subagent-rust-port.md. */
import { readFileSync } from "node:fs";
import { evaluateBashRules } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

export function run(): void {
{
// Phase 3 live proof: the permission rule matcher runs in Rust, through the public entry.
const golden = JSON.parse(readFileSync(
  "apps/zcode-cli/packages/core/testdata/agent-profiles/bash-rules-golden.json", "utf8"));
let mismatches = 0, accepted = 0;
for (const c of golden.cases) {
  const actual = evaluateBashRules(c);
  if (actual) accepted++;
  if (actual !== golden.verdicts[c.name]) { mismatches++; check(`case ${c.name}`, false); }
}
check(`all ${golden.cases.length} golden verdicts reproduced through the adapter`, mismatches === 0);
check("corpus is balanced (not all-true)", accepted > 0 && accepted < golden.cases.length);
// The security branches, asserted by intent rather than by fixture name:
// a pinned exact allow still works when the analysis says the command is unsafe.
check("exact allow beats unsafe",
  evaluateBashRules({ allSubjectGroups: [["git status"]], behavior: "allow",
    exactCommands: ["git status"], requiredSubjectGroups: [["git status"]],
    rules: [{ toolName: "bash", ruleContent: "git status" }], safe: false }));
// ...but unsafe without a matching rule is rejected. The exact-command short-circuit is
// `exactCommands ∩ rules.ruleContent`, NOT subject matching, so the pinned command here must
// not be a rule's own content — otherwise it short-circuits, which is correct.
check("unsafe without match rejected",
  !evaluateBashRules({ allSubjectGroups: [["rm -rf /"]], behavior: "allow",
    exactCommands: ["rm -rf /"], requiredSubjectGroups: [["rm -rf /"]],
    rules: [{ toolName: "bash", ruleContent: "git status" }], safe: false }));
check("exactCommands intersecting a rule content short-circuits",
  evaluateBashRules({ allSubjectGroups: [["rm -rf /"]], behavior: "allow",
    exactCommands: ["git status"], requiredSubjectGroups: [["rm -rf /"]],
    rules: [{ toolName: "bash", ruleContent: "git status" }], safe: false }));
// allow requires EVERY required group to be covered.
check("allow one group uncovered rejected",
  !evaluateBashRules({ allSubjectGroups: [["git status"], ["rm -rf /"]], behavior: "allow",
    exactCommands: [], requiredSubjectGroups: [["git status"], ["rm -rf /"]],
    rules: [{ toolName: "bash", ruleContent: "git:*" }], safe: true }));
// deny fires on ONE matching group.
check("deny fires on one group",
  evaluateBashRules({ allSubjectGroups: [["git status"], ["rm -rf /"]], behavior: "deny",
    exactCommands: [], requiredSubjectGroups: [],
    rules: [{ toolName: "bash", ruleContent: "rm -rf /" }], safe: true }));
// A rule with no content is a catch-all.
check("empty rule is catch-all",
  evaluateBashRules({ allSubjectGroups: [["anything"]], behavior: "allow",
    exactCommands: [], requiredSubjectGroups: [["anything"]],
    rules: [{ toolName: "bash" }], safe: false }));
// Cases verified against the ORIGINAL TypeScript (git show HEAD:…rule-evaluator.ts), run in
// its own module, because these are the branches the plain golden corpus does not reach.
const originalVerified: [string, any, boolean][] = [
  ["unsafe + non-intersecting exactCommands", { allSubjectGroups: [["rm -rf /"]], behavior: "allow",
    exactCommands: ["rm -rf /"], requiredSubjectGroups: [["rm -rf /"]],
    rules: [{ toolName: "bash", ruleContent: "git status" }], safe: false }, false],
  ["unsafe + intersecting exactCommands", { allSubjectGroups: [["rm -rf /"]], behavior: "allow",
    exactCommands: ["git status"], requiredSubjectGroups: [["rm -rf /"]],
    rules: [{ toolName: "bash", ruleContent: "git status" }], safe: false }, true],
  ["empty exactCommands never short-circuits", { allSubjectGroups: [["git status"]], behavior: "allow",
    exactCommands: [], requiredSubjectGroups: [["git status"]],
    rules: [{ toolName: "bash", ruleContent: "git status" }], safe: false }, false],
  ["exactCommands [\"]\"] with an empty rule", { allSubjectGroups: [["git status"]], behavior: "allow",
    exactCommands: [""], requiredSubjectGroups: [["git status"]],
    rules: [{ toolName: "bash", ruleContent: "" }], safe: false }, true],
];
for (const [name, input, expected] of originalVerified) {
  check(`original-TS verified: ${name}`, evaluateBashRules(input) === expected);
}
}
}
