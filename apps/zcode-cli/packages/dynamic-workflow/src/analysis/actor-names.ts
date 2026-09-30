/**
 * A compile-time courtesy diagnostic for duplicate named actors.
 *
 * The rule itself is **runtime**: the engine checks non-empty effective names for duplicates in createActor and a hit is a run-level failure
 * (`DuplicateActorName`). The reason is that a named actor is the identity key for an amend-resume cache import,
 * and any run is a potential predecessor of a future revision -- a duplicate name in the predecessor makes the import match ambiguous.
 *
 * What is done here is **the half a literal can see through**, in two sub-clauses:
 *
 * 1. **The same name in two places**: when the effective names of two `agent(...)` sites are the same string literal, a locatable
 *    diagnostic is reported at the later one, so the author renames on the cheap side instead of failing halfway through a run. Any dynamic component
 *    (`` `worker-${i}` ``, an identifier, a spread, a shorthand property) is skipped without exception -- only the runtime can check those.
 * 2. **A static name inside a fan-out**: when an `agent("x")` site runs inside a fan-out body, every element creates a new
 *    actor while they all share one name -- one site, N duplicates, so the runtime is bound to fail loudly.
 *
 * Sub-clause 1 **only under-reports, never false-positives**: skipping a site that may be a duplicate costs nothing (the engine catches it), while a false positive on a
 * legal script blocks the submission.
 *
 * The set of a `.map` may hold only <=1
 * element, and such a script is actually legal at runtime, so in theory this sub-clause false-positives. It is accepted because the costs are
 * asymmetric -- the fix is free (switch to a per-element name `` `x-${item}` `` or go anonymous), while the cost of not reporting is that the model burns a whole run
 * before learning the rule. `paths.map((p) => agent("reviewer").ask(…))` is the textbook way to write a fan-out,
 * and silently leaving it to the runtime is the worst of the lot.
 *
 * The detection of a fan-out **reuses the site table's classification** (the `IterationCandidate` of `analysis/sites.ts`: array methods with an inline
 * callback plus `for...of`), instead of inventing a second loop recognizer. The price is that ordinary `for` / `while` /
 * `do` loops are not in that classification and so are not covered by this sub-clause -- they fall back to the old posture of sub-clause 1 (invisible, left to the runtime).
 * That is exactly the under-reporting direction, consistent with the conservative posture of this module.
 *
 * Both the `CreateWorkflow` and the
 * `SaveWorkflow` handler run `analyzeScript` first (this diagnostic sits in the authoring batch of `analyzeWorkflowScript`),
 * and a `!ok` result returns early with the diagnostic and **does not submit / does not write to disk**, so a 9005/9006 really does
 * block both submission and saving. But `compileOnce` of the run service (the recompilation for submit and resume) only re-checks
 * typecheck / schema / the world.run literal trio, and **does not include** this diagnostic -- so it is not a mandatory gate on the submit path, do not treat it as
 * load-bearing: the authority for name uniqueness always remains the runtime duplicate check in the engine's createActor.
 */

import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** The same literal name in two places (sub-clause 1). 9001 = facade-siting, 9002 = schema, 9003 = world-run, 9004 = phase. */
const DUPLICATE_ACTOR_NAME_CODE = 9005;

/**
 * A static name inside a fan-out body (sub-clause 2), a separate code instead of reusing 9005.
 *
 * The two sub-clauses are one and the same rule, but their **determinism differs**: 9005 only appears when a duplicate is statically certain, while 9006 is the sub-clause above that deliberately
 * accepts false positives. The reading side therefore has to tell them apart -- especially the fixture corpus on the analysis side:
 * those scripts never execute and only pin down graph shapes, and the combination of a static name plus a fan-out is exactly the shape the **analyzer has to handle correctly**
 * (`ActorNode.family`, the actor labels), so the corpus must be exempt from 9006 while staying strict about 9005.
 * Sharing one code would leave no choice but to distinguish them by matching the message text, and routing by error text is exactly what this repository forbids everywhere.
 */
export const FANOUT_ACTOR_NAME_CODE = 9006;

/**
 * Collects the literal duplicate-name diagnostics. A non-empty result means the script cannot be submitted (it sits alongside the compile-time
 * rules of world.run / phase).
 */
export function collectDuplicateActorNames(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const claimed = new Map<string, ts.CallExpression>();
  // The collection of fan-out bodies comes from the site table's IterationCandidate (array method's inline callback body + for...of's
  // Loop body), which uses the same concept as `ActorNode.fanOutId` to determine "whether the site falls within the fan-out body".
  const fanOutBodies = new Set<ts.Node>(table.iterations.map((iteration) => iteration.body));
  for (const site of table.actors) {
    // The site table's `site.name` is not used here: it falls back to the binding name (`const planner = agent()`
    // Marked as "planner"), that is the display label used for the diagram, not a valid name at runtime. What's important here is that the engine will see it.
    // That value, so I read it from the actual parameter.
    const name = staticEffectiveName(site.call);
    if (name === undefined || name === "") continue;
    const first = claimed.get(name);
    if (first === undefined) claimed.set(name, site.call);
    const loc = workflow.toScriptLoc(site.call.getStart(workflow.scriptFile));
    // A site can report at most one: the fan-out clause is more specific (it even modifies it differently - by element name instead of changing the name),
    // So it takes priority. The name is still registered as usual, and subsequent sites with the same name should be reported again.
    if (isInsideFanOut(site.call, fanOutBodies)) {
      diagnostics.push({
        code: FANOUT_ACTOR_NAME_CODE,
        column: loc.column,
        line: loc.line,
        message:
          `this agent(...) runs once per element of a fan-out but its name "${name}" is a fixed ` +
          `string, so every element creates a different actor under the same name — the run ` +
          `fails with DuplicateActorName as soon as the collection holds more than one item. ` +
          `An actor name must be unique within a run: it is the identity key an amended re-run ` +
          `matches its imported cache against. Build a per-element name (\`${name}-\${item}\`), ` +
          `or drop the name — anonymous actors are legal (they just never reuse cached work).`,
      });
      continue;
    }
    if (first === undefined) continue;
    // The diagnosis falls in the last place: the name that appears first is the existing fact, and it is the later one that needs to be changed.
    const firstLoc = workflow.toScriptLoc(first.getStart(workflow.scriptFile));
    diagnostics.push({
      code: DUPLICATE_ACTOR_NAME_CODE,
      column: loc.column,
      line: loc.line,
      message:
        `two actors are named "${name}" (the first is on line ${firstLoc.line}): an actor name ` +
        `must be unique within a run. The name is the identity key an amended re-run matches ` +
        `its imported cache against, and any run can become the predecessor of one, so a ` +
        `repeated name makes that match ambiguous. Give this one its own name, or drop the ` +
        `name entirely — anonymous actors are legal (they just never reuse cached work).`,
    });
  }
  return diagnostics;
}

/**
 * Whether the call **lexically** lies inside some fan-out body. Walk the parent chain starting from the call itself (the call may be the body
 * itself: the arrow shorthand body of `paths.map((p) => agent("x"))`), and hitting any candidate body is a hit.
 */
function isInsideFanOut(call: ts.CallExpression, fanOutBodies: ReadonlySet<ts.Node>): boolean {
  for (let node: ts.Node | undefined = call; node !== undefined; node = node.parent) {
    if (fanOutBodies.has(node)) return true;
  }
  return false;
}

/**
 * The **effective name** statically knowable for an `agent(...)` call, otherwise undefined (= skip).
 *
 * The same rule as the engine's `normalizePersona`: persona.name overrides the name argument, and a string persona is a
 * system prompt that carries no name. Any part that cannot be seen through makes the whole thing be abandoned -- rather under-report.
 *
 * The facade's `AgentPersona` **does not declare name today**, so a persona a script can write never carries a name and the effective name
 * always falls to the name argument. That is why the persona part never triggers today; it is kept to stay in step with normalizePersona,
 * not to take effect today -- once the facade grows a name while this still judges by the name argument, an actor renamed via persona would be
 * **false-reported**, and a false positive blocks a legal script (an under-report costs nothing: the engine catches it at runtime).
 */
function staticEffectiveName(call: ts.CallExpression): string | undefined {
  const [nameArg, personaArg] = call.arguments;
  if (personaArg !== undefined && !ts.isStringLiteralLike(personaArg)) {
    if (!ts.isObjectLiteralExpression(personaArg)) return undefined; // Dynamic persona: possibly with name
    for (const property of personaArg.properties) {
      // Expansion may bring in a name, but static is not sure.
      if (ts.isSpreadAssignment(property)) return undefined;
      // The computed key (`{ ["na" + "me"]: … }`) is also uncertain: it could just be the name. Here we must give up the whole
      // Not `continue` - continue will fall back to the name actual parameter, which is equivalent to asserting that persona has not been renamed, that is once
      // Guessing, and guessing wrong happens to be a false positive (blocking legitimate scripts).
      if (property.name !== undefined && ts.isComputedPropertyName(property.name)) return undefined;
      if (property.name === undefined || !isNameKey(property.name)) continue;
      if (!ts.isPropertyAssignment(property)) return undefined; // shorthand / method: dynamic
      return ts.isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
    }
    // There is no name in the object literal, so the name argument falls back.
  }
  return nameArg !== undefined && ts.isStringLiteralLike(nameArg) ? nameArg.text : undefined;
}

/** Whether the property key is **statically determined** to be `name` (a computed key is already abandoned wholesale at the call site and does not come here). */
function isNameKey(key: ts.PropertyName): boolean {
  return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "name";
}
