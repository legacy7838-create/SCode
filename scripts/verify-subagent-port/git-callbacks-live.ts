/** Verification section: git-callbacks-live. See docs/specs/subagent-rust-port.md. */
import { readFileSync } from "node:fs";
import { readonlyCallbackIsDangerous } from "../../packages/rust/src/subagentProfile.ts";
import * as gitCallbacksTs from "../../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-git-callbacks.ts";
import type { ReadonlyDangerCallbackName } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

export function run(): void {
{
  // The git callbacks are the policy table's `additionalCommandIsDangerousCallback` values:
  // `git tag v1.0` MOVES a tag, `git reflog expire` destroys history, `--format=%G` runs a
  // signature check, `git ls-remote origin` reaches the network.
  const goldenPath = "apps/zcode-cli/packages/core/testdata/agent-profiles/git-callbacks-golden.json";
  const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<string, { dangerous: boolean; args: string[] }>;
  const adapters: Record<string, (a: string[]) => boolean> = {
    gitRevisionFormat: gitCallbacksTs.gitRevisionFormatCommandIsDangerous,
    gitReflog: gitCallbacksTs.gitReflogCommandIsDangerous,
    gitLsRemote: gitCallbacksTs.gitLsRemoteCommandIsDangerous,
    gitRemoteShow: gitCallbacksTs.gitRemoteShowCommandIsDangerous,
    gitTag: gitCallbacksTs.gitTagCommandIsDangerous,
    gitBranch: gitCallbacksTs.gitBranchCommandIsDangerous,
  };
  const nameFor: Record<string, string> = {
    revision_format_: "gitRevisionFormat", reflog_: "gitReflog", ls_remote_: "gitLsRemote",
    remote_show_: "gitRemoteShow", tag_: "gitTag", branch_: "gitBranch",
  };

  let mismatches = 0;
  for (const [name, entry] of Object.entries(golden)) {
    const key = nameFor[Object.keys(nameFor).find((prefix) => name.startsWith(prefix))!];
    if (readonlyCallbackIsDangerous(key as ReadonlyDangerCallbackName, entry.args) !== entry.dangerous) {
      mismatches += 1;
      check(`git golden ${name}`, false);
    }
  }
  check(`all ${Object.keys(golden).length} git-callback golden cases reproduce`, mismatches === 0);

  const probes: string[][] = [[], ["--list"], ["v1.0"], ["main"], ["expire"], ["show", "HEAD"],
    ["origin"], ["-n", "origin"], ["--heads"], ["--format=%G", "HEAD"], ["--format=%h %s", "HEAD"],
    ["--merged", "main"], ["--", "v1.0"], ["-al"], ["--contains", "abc"], ["--sort", "refname", "origin"]];
  let probeMismatch = 0;
  for (const [name, adapter] of Object.entries(adapters)) {
    for (const args of probes) {
      if (readonlyCallbackIsDangerous(name as ReadonlyDangerCallbackName, args) !== adapter("", args)) {
        probeMismatch += 1;
      }
    }
  }
  check(`all 6 git callbacks agree with the adapter across ${Object.keys(adapters).length * probes.length} probes`, probeMismatch === 0);

  check("tag v1.0 stays closed", readonlyCallbackIsDangerous("gitTag", ["v1.0"]));
  check("branch main stays closed", readonlyCallbackIsDangerous("gitBranch", ["main"]));
  check("reflog expire stays closed", readonlyCallbackIsDangerous("gitReflog", ["expire"]));
  check("%G signature stays closed", readonlyCallbackIsDangerous("gitRevisionFormat", ["--format=%G", "HEAD"]));
  check("ls-remote origin stays closed", readonlyCallbackIsDangerous("gitLsRemote", ["origin"]));
  check("remote show without -n stays closed", readonlyCallbackIsDangerous("gitRemoteShow", ["origin"]));
  check("tag --list stays clean", !readonlyCallbackIsDangerous("gitTag", ["--list"]));
  check("branch --list stays clean", !readonlyCallbackIsDangerous("gitBranch", ["--list"]));
  check("reflog show stays clean", !readonlyCallbackIsDangerous("gitReflog", ["show", "HEAD"]));
}
}
