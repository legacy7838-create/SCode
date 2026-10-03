/** Verification section: gh-callback-live. See docs/specs/subagent-rust-port.md. */
import { readFileSync } from "node:fs";
import { readonlyCallbackIsDangerous } from "../../packages/rust/src/subagentProfile.ts";
import * as ts from "../../apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-callbacks.ts";
import { check } from "./harness.js";

export function run(): void {
{
  // `gh` is the last danger callback; with it, NO danger-callback logic is left in TypeScript.
  const golden = JSON.parse(readFileSync("apps/zcode-cli/packages/core/testdata/agent-profiles/gh-callback-golden.json", "utf8")) as Record<string, { dangerous: boolean; args: string[] }>;
  let mismatches = 0;
  for (const [name, entry] of Object.entries(golden)) {
    if (readonlyCallbackIsDangerous("gh", entry.args) !== entry.dangerous) {
      mismatches += 1;
      check(`gh golden ${name}`, false);
    }
  }
  check(`all ${Object.keys(golden).length} gh golden cases reproduce`, mismatches === 0);

  const probes: string[][] = [[], ["status"], ["auth", "status"], ["cli/cli"], ["a/b/c"], ["user@h"],
    ["--repo=https://evil"], ["--repo=x/y/z"], ["--json"], ["--repo="], ["-R", "owner/repo"], ["cli/"]];
  let probeMismatch = 0;
  for (const args of probes) {
    if (readonlyCallbackIsDangerous("gh", args) !== ts.ghCommandIsDangerous("", args)) probeMismatch += 1;
  }
  check(`gh agrees with the adapter across ${probes.length} probes`, probeMismatch === 0);
  check("gh host target stays closed", readonlyCallbackIsDangerous("gh", ["user@evil"]));
  check("gh auth status stays clean", !readonlyCallbackIsDangerous("gh", ["auth", "status"]));
}
}
