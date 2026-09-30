// ============================================================
// Saved workflows - parameter verification
// ============================================================
//
// Verification occurs before the confirmation window: if the parameters are passed incorrectly, there is nothing worthy of user judgment, and popping up a window destined to fail is just
// Use an invalid decision to interrupt the model's own error correction loop. This is the same as CreateWorkflow's handling of scripts that cannot be compiled.
// Principle (`prepareApproval` comment in create-workflow.ts).

import type { SavedWorkflowArgDeclaration, SavedWorkflowArgsDeclaration } from "@zcode/contracts";

export type WorkflowArgsValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: string[] };

/**
 * Validates the arguments passed by the caller against the declarations and fills in the defaults.
 *
 * It collects **all** violations and returns them at once instead of bailing out on the first one: a model that is told "pr is missing and an extra
 * prNumber was passed" can fix everything in one go, while one told only "pr is missing" fixes it once and then trips again.
 *
 * Any argument handed to a workflow that declares no args is an error -- it cannot read them, and silently dropping them would make
 * the caller believe the arguments took effect.
 */
export function validateWorkflowArgs(
  declaration: SavedWorkflowArgsDeclaration | undefined,
  provided: Record<string, unknown> | undefined,
): WorkflowArgsValidation {
  const declared = declaration ?? {};
  const given = provided ?? {};
  const errors: string[] = [];
  const args: Record<string, unknown> = {};

  const declaredNames = Object.keys(declared);
  for (const key of Object.keys(given)) {
    if (declared[key] !== undefined) continue;
    errors.push(
      declaredNames.length === 0
        ? `unknown argument '${key}': this workflow declares no arguments`
        : `unknown argument '${key}' (declared: ${declaredNames.join(", ")})`,
    );
  }

  for (const [key, spec] of Object.entries(declared)) {
    const supplied = given[key];
    // Default and explicit undefined are treated the same: you can't pass undefined in JSON, so they can only be the same thing.
    if (supplied === undefined) {
      if (spec.default !== undefined) {
        // The default value and the incoming value go through the same type check: a parameter is declared as number but is written as "3" by default.
        // The mistake is at the moment of saving, you shouldn't wait until the script reads it before exploding.
        const failure = typeMismatch(key, spec, spec.default, "default value");
        if (failure === undefined) args[key] = spec.default;
        else errors.push(failure);
        continue;
      }
      if (spec.required === true) errors.push(`missing required argument '${key}'`);
      continue;
    }

    const failure = typeMismatch(key, spec, supplied, "value");
    if (failure === undefined) args[key] = supplied;
    else errors.push(failure);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, args };
}

/**
 * The explanation for a type mismatch, `undefined` when it matches.
 *
 * `json` accepts anything -- that is precisely what it means, "no checking here", so even null is a legal json value. The three primitives are judged by
 * typeof; `number` additionally rejects NaN and Infinity, because they cannot cross into the sandbox through JSON and letting them through would only move
 * a readable error into the script where it becomes a `null`.
 */
function typeMismatch(
  key: string,
  spec: SavedWorkflowArgDeclaration,
  value: unknown,
  what: string,
): string | undefined {
  const describe = (expected: string): string =>
    `argument '${key}': expected ${expected}, got ${describeValue(value)} (${what})`;

  switch (spec.type) {
    case "string":
      return typeof value === "string" ? undefined : describe("a string");
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : describe("a finite number");
    case "boolean":
      return typeof value === "boolean" ? undefined : describe("a boolean");
    case "json":
      return undefined;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
