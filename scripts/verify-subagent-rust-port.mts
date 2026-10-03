/**
 * Verification for the subagent Rust port — run it yourself.
 *
 *   pnpm exec tsx scripts/verify-subagent-rust-port.mts
 *
 * Spec: docs/specs/subagent-rust-port.md.
 *
 * This checks the WIRING, not just the rules: the Rust unit tests replay the golden corpora
 * against the crate, while this exercises the napi boundary the product actually calls — a
 * napi signature typo type-checks and still fails at runtime.
 *
 * Sections live in `scripts/verify-subagent-port/` because the repository enforces a maximum
 * file length and one file for all of them exceeded it.
 */
import { section, tally } from "./verify-subagent-port/harness.js";
import { run as run_profile_live } from "./verify-subagent-port/profile-live.js";
import { run as run_artifacts_live } from "./verify-subagent-port/artifacts-live.js";
import { run as run_lifecycle_live } from "./verify-subagent-port/lifecycle-live.js";
import { run as run_mirror_live } from "./verify-subagent-port/mirror-live.js";
import { run as run_cancel_live } from "./verify-subagent-port/cancel-live.js";
import { run as run_gitflags_live } from "./verify-subagent-port/gitflags-live.js";
import { run as run_argvpolicy_live } from "./verify-subagent-port/argvpolicy-live.js";
import { run as run_callbacks_all_live } from "./verify-subagent-port/callbacks-all-live.js";
import { run as run_rules_live } from "./verify-subagent-port/rules-live.js";
import { run as run_result_budget_live } from "./verify-subagent-port/result-budget-live.js";
import { run as run_bash_semantics_live } from "./verify-subagent-port/bash-semantics-live.js";
import { run as run_git_runtime_safety_live } from "./verify-subagent-port/git-runtime-safety-live.js";
import { run as run_git_callbacks_live } from "./verify-subagent-port/git-callbacks-live.js";
import { run as run_tables_live } from "./verify-subagent-port/tables-live.js";
import { run as run_readonly_policy_live } from "./verify-subagent-port/readonly-policy-live.js";

for (const [title, run] of [
  ["live-proof", run_profile_live],
  ["artifacts-live", run_artifacts_live],
  ["lifecycle-live", run_lifecycle_live],
  ["mirror-live", run_mirror_live],
  ["cancel-live", run_cancel_live],
  ["gitflags-live", run_gitflags_live],
  ["argvpolicy-live", run_argvpolicy_live],
  ["callbacks-all-live", run_callbacks_all_live],
  ["rules-live", run_rules_live],
  ["result-budget-live", run_result_budget_live],
  ["bash-semantics-live", run_bash_semantics_live],
  ["git-runtime-safety-live", run_git_runtime_safety_live],
  ["git-callbacks-live", run_git_callbacks_live],
  ["tables-live", run_tables_live],
  ["readonly-policy-live", run_readonly_policy_live],
] as [string, () => void][]) {
  section(title);
  run();
}

const { passed, failed } = tally();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  // Loud, never "degraded but continued": a missing binary or a drifted rule stops here.
  process.exit(1);
}
console.log("SUBAGENT RUST PORT VERIFICATION PASSED");
