import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import { collectSites, type SiteTable } from "../analysis/sites.js";
import { createWorkflowProgram, collectDiagnostics } from "../compiler/compile.js";
// AskSpec is the engine's input parameter vocabulary, here only import type (erased at compile time, no runtime side). engine side
// Similarly, only the Violation of the schema is introduced in the form of type - both directions are pure types, and there is no import loop.
import type { AskSpec } from "../engine/types.js";
import { SchemaEmitter, SchemaRejection } from "./emit.js";
import { harvestConstraints, mergeConstraints } from "./jsdoc.js";
import type { JsonSchema } from "./types.js";
import { SCHEMA_DIAGNOSTIC_CODE } from "./types.js";

/**
 * Schema synthesis (compile side): for every "typed" ask site, use the checker's structured
 * view to emit the result type T as a plain JSON Schema, archived by site id (such as
 * `ask#1`).
 *
 * How "typed" is decided: the ask explicitly carries type arguments `x.ask<T>(...)` and T
 * does not resolve to the primitive `string`. Both `ask()` and `ask<string>()` are "untyped"
 * asks (the result is the final text, so no schema is emitted). A non-serializable T is
 * rejected with a diagnostic located at the ask site (reusing the analysis pipeline's
 * CompileDiagnostic shape).
 *
 * The same pass also checks the serializability of `report(item)`'s arguments — the same
 * emitter, the same diagnostic channel, for the reason given in
 * {@link reportItemDiagnostics}. Report sites **produce no schema**, they only contribute
 * diagnostics.
 */

export interface SchemaSynthesisResult {
  /** The JSON Schema of each typed ask site, archived by site id. */
  schemas: Record<string, JsonSchema>;
  /** A rejecting diagnostic, located at the corresponding ask site. */
  diagnostics: CompileDiagnostic[];
}

/**
 * The result type T of an ask site, or undefined if it is an "untyped" ask. This is the
 * single source of truth for the typed-ask decision: the site table (analysis/sites.ts) keeps
 * only `call: ts.CallExpression` with no typed marker, so it is resolved from the checker
 * here. Untyped = T resolves to the primitive `string` (both the default argument of `ask()`
 * and an explicit `ask<string>()` fall in this class; `type A = string; ask<A>()` is also
 * resolved by the checker as the primitive string).
 *
 * Kept private to the module: downstream (lowering/engine/driver) needs no standalone
 * predicate — a run that starts successfully has zero diagnostics by construction, so
 * `siteId in schemas` *is* the typed-ask test. But **do not** on that basis build the
 * engine's askSpecs from the keys of schemas: untyped sites would be missing entirely, and
 * the engine treats a missing site as a wiring error and fails hard. Building askSpecs
 * always goes through {@link buildAskSpecs} (iterating the site table).
 */
function askResultType(checker: ts.TypeChecker, call: ts.CallExpression): ts.Type | undefined {
  const typeNode = call.typeArguments?.[0];
  if (typeNode === undefined) return undefined;
  const type = checker.getTypeFromTypeNode(typeNode);
  return (type.flags & ts.TypeFlags.String) !== 0 ? undefined : type;
}

/**
 * The core entry point: on the very same checker used to build the site table, emit a schema
 * for every typed ask. This corresponds to `synthesizeAskSchemas(program, siteTable)` in the
 * docs; it takes a {@link WorkflowProgram} here so it can get `toScriptLoc` for located
 * diagnostics.
 */
export function synthesizeAskSchemas(
  workflow: WorkflowProgram,
  table: SiteTable,
): SchemaSynthesisResult {
  const checker = workflow.program.getTypeChecker();
  const schemas: Record<string, JsonSchema> = {};
  const diagnostics: CompileDiagnostic[] = [];

  for (const site of table.asks) {
    const type = askResultType(checker, site.call);
    if (type === undefined) continue; // Untyped ask: the result is the final text, no schema is emitted

    try {
      const typeNode = site.call.typeArguments![0]!;
      const emitter = new SchemaEmitter(checker, typeNode);
      schemas[site.id] = attachTopDoc(emitter.emitTop(type), type, checker);
    } catch (error) {
      if (!(error instanceof SchemaRejection)) throw error;
      diagnostics.push({
        code: SCHEMA_DIAGNOSTIC_CODE,
        column: site.loc.column,
        line: site.loc.line,
        message: rejectionMessage(error, "ask result type"),
      });
    }
  }

  for (const site of table.reports) diagnostics.push(...reportItemDiagnostics(checker, site));

  return { diagnostics, schemas };
}

/**
 * The serializability check for `report(item)`'s arguments.
 *
 * Why it rides **the same checker walk, the same emitter and the same diagnostic channel**
 * as ask schema synthesis: a reported item and an artifact cross the journal and protocol
 * boundaries for exactly the same reasons, so "what counts as serializable" has to be one
 * and the same answer. Standing up a parallel checker means starting to maintain a second
 * source of truth — and the day the two diverge, it will show up as a `{}` in some run's
 * Results panel and nowhere else.
 *
 * Two differences from ask:
 *   1. **No schema is produced.** A report has no validation target — no model submits
 *      anything against it, the item is a value the script computed itself. All that is
 *      wanted here is the yes/no answer to "can it be serialized", so the emitted schema is
 *      simply discarded.
 *   2. The type comes from the **argument expression** rather than from type arguments. The
 *      facade declares the parameter as `unknown` (`unknown` is a legal any-JSON for the
 *      emitter), so the question is "what type is the value you actually passed in". In
 *      `report(x)`, an x that is `unknown` or an ordinary JSON shape passes, while a `Date` /
 *      function / class instance / Promise is rejected with a diagnostic located at the call
 *      site.
 */
function reportItemDiagnostics(
  checker: ts.TypeChecker,
  site: SiteTable["reports"][number],
): CompileDiagnostic[] {
  // If the actual parameters are absent, typecheck will be responsible for reporting errors (the `item` of the facade is a required parameter), and there is nothing to do here.
  if (site.item === undefined) return [];
  try {
    new SchemaEmitter(checker, site.item).emitTop(checker.getTypeAtLocation(site.item));
    return [];
  } catch (error) {
    if (!(error instanceof SchemaRejection)) throw error;
    return [
      {
        code: SCHEMA_DIAGNOSTIC_CODE,
        column: site.loc.column,
        line: site.loc.line,
        message: rejectionMessage(error, "report item type"),
      },
    ];
  }
}

/**
 * A convenience entry point: synthesize from script text in one shot (typecheck → site table
 * → synthesis). It gives in-package/engine-side call sites a place that need not assemble
 * program+table themselves; analyzeWorkflowScript belongs to the analysis domain and is not
 * touched here. If the script itself fails typecheck, its compile diagnostics are returned
 * and no synthesis happens.
 */
export function synthesizeWorkflowSchemas(scriptText: string): SchemaSynthesisResult {
  const workflow = createWorkflowProgram(scriptText);
  const compileDiagnostics = collectDiagnostics(workflow.program);
  if (compileDiagnostics.length > 0) return { diagnostics: compileDiagnostics, schemas: {} };
  return synthesizeAskSchemas(workflow, collectSites(workflow));
}

/**
 * Assemble the site table and the synthesized schemas into the engine's `askSpecs`.
 *
 * **Why iterate `table.asks` instead of the keys of `schemas`**: schemas are only emitted for
 * typed sites (an untyped ask's result is the final turn's text, so no schema is emitted),
 * while the engine requires askSpecs to cover **every** ask site — a missing site is treated
 * as a wiring error and fails hard (`MissingAskSpec`), because the site table and the schema
 * synthesis come out of the same compilation, so absence can only mean two artifacts got
 * spliced together. Untyped sites must therefore be recorded explicitly as
 * `{ typed: false }` rather than relying on a "not found means untyped" fallback: that
 * fallback would silently downgrade a typed ask — submit_result is never registered, the
 * final turn's text is taken as the result, and schema validation vanishes entirely.
 *
 * This construction is correctness-critical and has exactly one form, which is why it is
 * collected here: callers (the run service, test assembly) should all use it instead of
 * implementing their own. The site table is the single source of truth for identity — keys
 * in schemas that match no site are ignored.
 */
export function buildAskSpecs(table: SiteTable, schemas: Record<string, JsonSchema>): Map<string, AskSpec> {
  const specs = new Map<string, AskSpec>();
  for (const site of table.asks) {
    const schema = schemas[site.id];
    specs.set(site.id, schema === undefined ? { typed: false } : { typed: true, schema });
  }
  return specs;
}

/** The description/constraints of the top-level type: taken from its alias or symbol (a named interface/type alias). */
function attachTopDoc(schema: JsonSchema, type: ts.Type, checker: ts.TypeChecker): JsonSchema {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol === undefined) return schema;
  return mergeConstraints(schema, harvestConstraints(symbol, checker));
}

function rejectionMessage(error: SchemaRejection, subject: string): string {
  const where = error.path !== "$" && error.path.length > 0 ? ` (at ${error.path})` : "";
  return `unsupported ${subject}: ${error.reason}${where}`;
}
