/** Verification section: gitflags-live. See docs/specs/subagent-rust-port.md. */
import { hasDangerousGitGlobalOption, hasDangerousGitGlobalOptionWord } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

export function run(): void {
{
// Phase 3 live proof: the git global-option safety gate runs in Rust.
// 1. the attack this gate exists to stop: arbitrary command via git config
check("-c core.pager=sh is dangerous",
  hasDangerousGitGlobalOption(["git", "-c", "core.pager=sh", "log"]));
check("--exec-path is dangerous",
  hasDangerousGitGlobalOption(["git", "--exec-path=/tmp/evil", "log"]));
check("--git-dir is dangerous",
  hasDangerousGitGlobalOption(["git", "--git-dir=/elsewhere/.git", "status"]));
// 2. ordinary read-only git stays clean
check("git status is clean", !hasDangerousGitGlobalOption(["git", "status"]));
check("git log --oneline is clean", !hasDangerousGitGlobalOption(["git", "log", "--oneline"]));
check("--no-pager is clean", !hasDangerousGitGlobalOption(["git", "--no-pager", "log"]));
check("--color is not confused with --config", !hasDangerousGitGlobalOption(["git", "--color", "log"]));
// 3. short-flag asymmetry preserved
check("-C/tmp is dangerous", hasDangerousGitGlobalOption(["git", "-C/tmp", "status"]));
check("-cfoo=bar is dangerous", hasDangerousGitGlobalOption(["git", "-cfoo=bar", "log"]));
check("-C--x is dangerous (not inspected)", hasDangerousGitGlobalOption(["git", "-C--x", "status"]));
check("-c--x is clean (next char is -)", !hasDangerousGitGlobalOption(["git", "-c--x", "log"]));
check("-fsomething is clean", !hasDangerousGitGlobalOption(["git", "-fsomething", "log"]));
// 4. the word form used by normalizeGitArgv agrees with the argv form
const argv = ["git", "status", "--bare"];
check("argv form agrees", hasDangerousGitGlobalOption(argv) === argv.some(hasDangerousGitGlobalOptionWord));
const argv2 = ["git", "log"];
check("argv form agrees (clean)", hasDangerousGitGlobalOption(argv2) === argv2.some(hasDangerousGitGlobalOptionWord));
}
}
