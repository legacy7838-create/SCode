/** Verification section: bash-semantics-live. See docs/specs/subagent-rust-port.md. */
import { isRuntimeReadOnlyBashCommand, isSilentBashCommand } from "../../apps/zcode-cli/packages/core/src/tool/handlers/bash-semantics.ts";
import { readGolden } from "./harness.js";
import { check } from "./harness.js";

export function run(): void {
  // End to end on purpose: a real command string through the REAL grammar into the Rust
  // decision. This is the only check that exercises the seam between the two halves.
  const golden = readGolden<Record<string, { command: string; readOnly: boolean; silent: boolean }>>(
    "apps/zcode-cli/packages/core/testdata/agent-profiles/bash-semantics-golden.json",
  );
  let mismatches = 0;
  for (const [name, entry] of Object.entries(golden)) {
    if (isRuntimeReadOnlyBashCommand(entry.command) !== entry.readOnly) {
      mismatches += 1;
      check(`readOnly ${name}`, false);
    }
    if (isSilentBashCommand(entry.command) !== entry.silent) {
      mismatches += 1;
      check(`silent ${name}`, false);
    }
  }
  check(`all ${Object.keys(golden).length} golden command lines reproduce end to end`, mismatches === 0);

  // The boundary that decides whether a whole line counts as read-only.
  check("ls is read-only", isRuntimeReadOnlyBashCommand("ls") === true);
  check("ls && git status is read-only", isRuntimeReadOnlyBashCommand("ls && git status") === true);
  check("git push is not read-only", isRuntimeReadOnlyBashCommand("git push") === false);
  check("ls || rm -rf / is not read-only", isRuntimeReadOnlyBashCommand("ls || rm -rf /") === false);
  check("cat > out.txt is not read-only", isRuntimeReadOnlyBashCommand("cat file > out.txt") === false);
  check("cat < file stays read-only", isRuntimeReadOnlyBashCommand("cat < file") === true);
  check("cd && git is not read-only", isRuntimeReadOnlyBashCommand("cd /tmp && git status") === false);
  check("find -delete is not read-only", isRuntimeReadOnlyBashCommand("find . -delete") === false);
  check("sed -i is not read-only", isRuntimeReadOnlyBashCommand("sed -i 's/a/b/' f") === false);
  check("unknown command is not read-only", isRuntimeReadOnlyBashCommand("zzz-not-real") === false);
  check("empty is not read-only", isRuntimeReadOnlyBashCommand("") === false);
  check("unbalanced quote is not read-only", isRuntimeReadOnlyBashCommand("echo 'unterminated") === false);
  check("command substitution is not read-only", isRuntimeReadOnlyBashCommand("echo $(rm -rf /)") === false);
  check("LANG=C ls stays read-only", isRuntimeReadOnlyBashCommand("LANG=C ls") === true);
  check("rm alone is silent", isSilentBashCommand("rm file") === true);
  check("ls is not silent", isSilentBashCommand("ls") === false);
}
