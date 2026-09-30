/**
 * Compile-time command collection for world.run.
 *
 * The authorization surface of `world.run` is **approve + pin**: the cmd must be a compile-time string literal, so the command set of
 * the script is a closed set already before submission -- the confirmation dialog displays it and the driver re-checks it at execution. A cmd that only
 * takes shape at runtime has no displayable authorization object, so it gets a locatable diagnostic rather than a runtime rejection (the teaching rewrite happens on the cheap side,
 * the same posture as the facade-siting rule).
 *
 * Only the first argument is inspected: the args array and opts may carry runtime values (interpolating an ask product into args is exactly the source of a data edge);
 * what is pinned is "which command to run", not "what to run it with".
 */

import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** The diagnostic code for a non-literal world.run cmd (9001 = facade-siting, 9002 = schema, and so on). */
export const WORLD_RUN_LITERAL_CODE = 9003;

export interface WorldRunCommands {
  /** The command set declared by the script: deduplicated, lexicographic (the shape shared by the confirmation dialog and the driver re-check). */
  commands: string[];
  /** The locatable diagnostic for a non-literal cmd; non-empty means the script cannot be submitted. */
  diagnostics: CompileDiagnostic[];
}

/**
 * Collects the world.run command set from the site table. The cmd must be a hole-free string literal (`"lean"` or
 * `` `lean` `` -- `ts.isStringLiteralLike` covers both; a template with holes and any other expression are rejected).
 */
export function collectWorldRunCommands(
  workflow: WorkflowProgram,
  table: SiteTable,
): WorldRunCommands {
  const commands = new Set<string>();
  const diagnostics: CompileDiagnostic[] = [];
  for (const site of table.worldReads) {
    if (site.op !== "run") continue;
    const cmd = site.args[0];
    if (cmd !== undefined && ts.isStringLiteralLike(cmd)) {
      commands.add(cmd.text);
      continue;
    }
    // Element errors (cmd absence) are blocked first by type checking: the absence that can reach this point means that the call point should not even be compiled,
    // But diagnostic collection should not rely on this inference - reporting by site location would rather have one more error that can be located.
    const loc = cmd === undefined ? site.loc : workflow.toScriptLoc(cmd.getStart());
    diagnostics.push({
      code: WORLD_RUN_LITERAL_CODE,
      column: loc.column,
      line: loc.line,
      message:
        "world.run's first argument must be a compile-time string literal (\"lean\" or a " +
        "no-substitution template): the script's command set is shown to the user at " +
        "confirmation and only those commands are executable. Move the command name out of " +
        "the variable/template, and put runtime values in the args array instead.",
    });
  }
  return { commands: [...commands].sort(), diagnostics };
}
