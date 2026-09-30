/**
 * The compile-time validation of `phase("…")` markers.
 *
 * Two rules, one reason — a **marker has to make clear before the submission what it refers to**. The name is a compile-time literal,
 * because the phase set is displayed in the confirmation window (the same posture as the cmd of `world.run`: a name that only takes shape at runtime has nothing displayable
 * to show); the call must be a standalone statement, because the whole meaning of a marker is "from here to the end of the block", and a marker stuck in an initializer /
 * argument / ternary arm has no range to refer to. Both are **positional diagnostics** rather than runtime fallbacks: teaching the rewrite happens
 * on the cheap side.
 *
 * The alias escape (`const p = phase`) is not handled here — `phase` is a facade function declaration, and pass 1 of facade-misuse
 * has already rejected every reference that is not in a direct call position.
 */

import ts from "typescript";
import type { CompileDiagnostic, ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** The diagnostic codes of the phase markers (9001 = facade-siting, 9002 = schema, 9003 = world-run, and so on). */
export const PHASE_MARKER_CODE = 9004;

const LITERAL_MESSAGE =
  'phase()\'s argument must be a compile-time string literal ("gate" or a no-substitution ' +
  "template): the script's phase names are fixed when it is submitted, because they label " +
  "the graph the user confirms before anything runs. Write the name inline — a name that " +
  "only exists at run time cannot be drawn.";

const EMPTY_MESSAGE =
  'phase("") has no name to show: the phase label is what the confirmation graph draws. ' +
  'Give the group a word ("preflight", "gate", "wrap-up"), or drop the marker — a script ' +
  "with no markers is perfectly legal and is drawn step by step.";

const STATEMENT_MESSAGE =
  'phase("…") must stand alone as its own statement. The marker claims the rest of the block ' +
  "it stands in, so one in expression position (a variable initializer, an argument, a " +
  "ternary arm) has no rest-of-block to claim. Put the call on its own line at the head of " +
  "the steps it names.";

/**
 * Validates the collected phase markers. Non-empty means the script cannot be submitted (`analyzeWorkflowScript` handles it alongside
 * misuse / world.run).
 *
 * One marker can break both rules at once (`const x = phase(bad)`), and both are reported: the author sees everything to change in one go.
 */
export function collectPhaseMarkerDiagnostics(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const push = (loc: ScriptLoc, message: string): void => {
    diagnostics.push({ code: PHASE_MARKER_CODE, column: loc.column, line: loc.line, message });
  };

  for (const marker of table.phases) {
    // The diagnosis of the name falls on the expression in question (returning to the calling position in its absence): that is what the author wants to change.
    const nameLoc =
      marker.nameExpr === undefined
        ? marker.loc
        : workflow.toScriptLoc(marker.nameExpr.getStart(workflow.scriptFile));
    if (marker.name === undefined) {
      push(nameLoc, LITERAL_MESSAGE);
    } else if (marker.name.trim() === "") {
      push(nameLoc, EMPTY_MESSAGE);
    }
    if (!ts.isExpressionStatement(marker.call.parent)) {
      push(marker.loc, STATEMENT_MESSAGE);
    }
  }
  return diagnostics;
}
