/** Verification section: git-callbacks-live. See docs/specs/subagent-rust-port.md. */
import { readFileSync } from "node:fs";
import { readonlyCallbackIsDangerous } from "../../packages/rust/src/subagentProfile.ts";
import type { ReadonlyDangerCallbackName } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

/** Case-name prefix -> the Rust dispatch name. */
const NAME_FOR: Record<string, ReadonlyDangerCallbackName> = {
  revision_format_: "gitRevisionFormat",
  reflog_: "gitReflog",
  ls_remote_: "gitLsRemote",
  remote_show_: "gitRemoteShow",
  tag_: "gitTag",
  branch_: "gitBranch",
};

export function run(): void {
  // These close the gap between "the subcommand is on the read-only list" and "these
  // particular arguments still do something": `git tag v1.0` MOVES a tag,
  // `git reflog expire` destroys history, `--format=%G` runs a signature check, and
  // `git ls-remote origin` reaches the network.
  //
  // The oracle is the recorded golden corpus — captured from the TypeScript original
  // before it was deleted, which is why that code is gone.
  const golden = JSON.parse(
    readFileSync(
      "apps/zcode-cli/packages/core/testdata/agent-profiles/git-callbacks-golden.json",
      "utf8",
    ),
  ) as Record<string, { dangerous: boolean; args: string[] }>;

  let mismatches = 0;
  let total = 0;
  for (const [name, entry] of Object.entries(golden)) {
    const prefix = Object.keys(NAME_FOR).find((candidate) => name.startsWith(candidate));
    if (prefix === undefined) continue;
    total += 1;
    if (readonlyCallbackIsDangerous(NAME_FOR[prefix]!, entry.args) !== entry.dangerous) {
      mismatches += 1;
      check(`git golden ${name}`, false);
    }
  }
  check(`all ${total} git-callback golden cases reproduce`, mismatches === 0);

  // The destructive verbs, asserted by intent so a regression names the command.
  check("tag v1.0 stays closed", readonlyCallbackIsDangerous("gitTag", ["v1.0"]));
  check("branch main stays closed", readonlyCallbackIsDangerous("gitBranch", ["main"]));
  check("reflog expire stays closed", readonlyCallbackIsDangerous("gitReflog", ["expire"]));
  check("%G signature stays closed", readonlyCallbackIsDangerous("gitRevisionFormat", ["--format=%G", "HEAD"]));
  check("ls-remote origin stays closed", readonlyCallbackIsDangerous("gitLsRemote", ["origin"]));
  check("remote show without -n stays closed", readonlyCallbackIsDangerous("gitRemoteShow", ["origin"]));

  // ...and the listing forms must stay clean.
  check("tag --list stays clean", !readonlyCallbackIsDangerous("gitTag", ["--list"]));
  check("branch --list stays clean", !readonlyCallbackIsDangerous("gitBranch", ["--list"]));
  check("reflog show stays clean", !readonlyCallbackIsDangerous("gitReflog", ["show", "HEAD"]));
}
