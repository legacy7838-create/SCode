/**
 * Compile-time collection of artifacts and diagnostics about them.
 *
 * ⚠ Terminology: the artifact in this module is a **user-facing artifact** — a file / markdown / preset board that the script publishes for users through `artifact.*`. What
 * `artifact-types.ts` in the same directory talks about is a **different** artifact: a node's typed output value (meant for the model). The two are unrelated.
 *
 * There are two things about artifacts:
 *
 * 1. `declaredArtifacts` (a compile-time product, mirroring the `commands` of `collectWorldRunCommands`): the list of artifacts declared by
 *    the script, `[{id, kind}]`, deduplicated and sorted by id. It lets the hub and the inspector say **before the run** what this
 *    workflow will produce.
 * 2. Siting diagnostics (the facade-misuse family): an id must be a compile-time literal, a label must point at an already declared preset,
 *    one id must not straddle two member kinds, and a preset declaration must not sit in a loop body / callback / conditional branch.
 *
 * Why an id must be a compile-time literal (the same stance as the cmd of `world.run` and the name of `phase`): an id that only takes shape at run time has nothing displayable —
 * it cannot get into the "will produce" list, and it would leave rules like "two kinds under one id" with a single run-time path left.
 * The teaching rewrite has to happen on the cheaper side.
 *
 * Division of labour with run time: this pass only does **the half that literals can see through**. The real gate is in the engine — `ArtifactKindMismatch`
 * /`ArtifactRedeclared`/`ArtifactUndeclared`/`ArtifactCapExceeded` all backstop at run time, because the
 * **execution order** of the declarations (which one runs first) is not statically visible. So this module **only under-reports, never false-positives**,
 * and the sole exception is the hoisting diagnostic (see {@link ARTIFACT_HOISTING_CODE}).
 */

import ts from "typescript";
import type { CompileDiagnostic, ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import { ARTIFACT_CAPS, ARTIFACT_ID_PATTERN } from "../facade/artifact-caps.js";
import { isArtifactPresetOp, type ArtifactOp } from "../facade/registry.js";
import { findWorkflowBody, type ArtifactSite, type SiteTable } from "./sites.js";

/**
 * The compile-time diagnostic codes for artifacts (9001 = facade-siting, 9002 = schema, 9003 = world-run, 9004 = phase,
 * 9005/9006 = actor names, and so on). Coverage: an id that is non-literal / empty / too long / contains illegal characters, an id reused across kinds,
 * and the three ways of getting a `report` label wrong. All of them are **statically certain** errors — not one of them can hurt a legitimate script.
 */
export const ARTIFACT_DECLARATION_CODE = 9007;

/**
 * A preset declaration sits in a loop body / callback / conditional branch ("move the declaration to the top level, once is enough"). It gets its own code instead of
 * reusing 9007, for exactly the same reason 9005/9006 are split out: **the certainty is different**.
 *
 * Repeating a declaration with the **same spec** inside a loop is in fact an idempotent no-op at run time, so this clause is theoretically prone to false positives. It is accepted
 * because the costs are asymmetric — fixing it is free (move the declaration to the top of the script), while the cost of not reporting it is a board declaration
 * hidden in a third-level callback, and the reader has to run it once to find out whether it declared anything at all. The read side (fixture corpora, a future lenient tier)
 * therefore has to be able to tell it apart from 9007, and routing by error text is forbidden everywhere in this repository.
 */
export const ARTIFACT_HOISTING_CODE = 9008;

/**
 * Two **different** ids both wrote a literal `primary: true`.
 * The certainty is the same as 9008's: marking one in each arm of a mutually exclusive branch does run, but the card and the side panel will only ever deliver the first one, and
 * it stays unclear which was intended — the script is simply unfinished. Only a literal `true` is recognized; a computed flag is left to the engine's `ArtifactPrimaryConflict`.
 */
export const ARTIFACT_PRIMARY_CONFLICT_CODE = 9009;

/** One artifact declared by the script: an id plus its member kind. */
export interface DeclaredArtifact {
  id: string;
  /** The member kind (`file` / `markdown` / `chart` / `table` / `metrics` / `board`). */
  kind: ArtifactOp;
}

export interface ArtifactDeclarations {
  /** The list of artifacts declared by the script: deduplicated, sorted by id (the same shape as `declaredCommands`). */
  declaredArtifacts: DeclaredArtifact[];
  /** A siting diagnostic; a non-empty list means the script cannot be submitted. */
  diagnostics: CompileDiagnostic[];
}

/** The lexical position a preset declaration sits in — a position it should not be in. */
type HoistingContext = "loop" | "callback" | "conditional";

const HOISTING_MESSAGE: Record<HoistingContext, string> = {
  callback:
    "a preset artifact declared inside a callback: hoist it to the top level and declare it once. " +
    "A preset is a declaration, not a step — it says how the items tagged with its id are drawn, " +
    "and the tagged report() calls are what fill it in. Declaring it where the callback runs " +
    'buries it: move artifact.<kind>("<id>", spec) to the head of the script and keep only ' +
    'report(item, "<id>") in the callback.',
  conditional:
    "a preset artifact declared inside a conditional branch: hoist it to the top level and declare " +
    "it once. The card should exist from the moment the run starts (it is legitimately empty until " +
    "the first tagged report arrives), and a declaration that may or may not have run is a card " +
    "that may or may not exist. Declare it unconditionally and let the branch decide what to report.",
  loop:
    "a preset artifact declared inside a loop: hoist it to the top level and declare it once. " +
    "A preset is declared once and fed many times — the loop body is where report(item, \"<id>\") " +
    "belongs, not the declaration. Re-declaring the same spec is a no-op, but re-declaring it with " +
    "a different spec fails the whole run, so the loop is the wrong place for it either way.",
};

const NON_LITERAL_ID_MESSAGE =
  "an artifact id must be a compile-time string literal (\"report\" or a no-substitution template): " +
  "the set of artifacts a run can publish is fixed when the script is submitted, so it can be listed " +
  "before anything runs. Write the id inline; put the runtime value in the title instead " +
  '(artifact.file("report", path, { title: `Report for ${name}` })).';

const EMPTY_ID_MESSAGE =
  "an artifact id must not be empty: it is the identity the card, the version history and the " +
  'report tag all key off. Give it a short stable name ("book", "perf", "coverage").';

/**
 * Collects the artifact list and the diagnostics. A non-empty diagnostic list means the script cannot be submitted (`analyzeWorkflowScript` sits on the same stage as the
 * compile-time rules for world.run / phase / actor names).
 */
export function collectArtifactDeclarations(
  workflow: WorkflowProgram,
  table: SiteTable,
): ArtifactDeclarations {
  const diagnostics: CompileDiagnostic[] = [];
  const push = (code: number, loc: ScriptLoc, message: string): void => {
    diagnostics.push({ code, column: loc.column, line: loc.line, message });
  };
  const locOf = (node: ts.Node): ScriptLoc =>
    workflow.toScriptLoc(node.getStart(workflow.scriptFile));

  const body = findWorkflowBody(workflow.scriptFile);
  /** id → the first site that used it (used to point at the earlier occurrence when kinds conflict). */
  const claimed = new Map<string, ArtifactSite>();
  /** The first site that wrote a literal `primary: true`; a second one under a different id is 9009. */
  let primaryClaim: { id: string; site: ArtifactSite } | undefined;
  const declared: DeclaredArtifact[] = [];

  for (const site of table.artifacts) {
    // The diagnosis of id falls on the expression that caused the problem (return to the site location in absence, the same as world-run's processing:
    // Numeric errors are blocked first by type checking, but diagnostic collection should not rely on that inference).
    const idLoc = site.artifactIdExpr === undefined ? site.loc : locOf(site.artifactIdExpr);
    if (site.artifactId === undefined) {
      push(ARTIFACT_DECLARATION_CODE, idLoc, NON_LITERAL_ID_MESSAGE);
      continue;
    }
    const id = site.artifactId;
    if (id === "") {
      push(ARTIFACT_DECLARATION_CODE, idLoc, EMPTY_ID_MESSAGE);
      continue;
    }
    if (id.length > ARTIFACT_CAPS.maxIdLength) {
      push(
        ARTIFACT_DECLARATION_CODE,
        idLoc,
        `artifact id "${id}" is ${id.length} characters; the limit is ${ARTIFACT_CAPS.maxIdLength}. ` +
          "The id is a key, not a description — put the prose in the title.",
      );
      continue;
    }
    if (!ARTIFACT_ID_PATTERN.test(id)) {
      push(
        ARTIFACT_DECLARATION_CODE,
        idLoc,
        `artifact id "${id}" contains characters outside [A-Za-z0-9_.-]. The id is carried verbatim ` +
          "through the journal, the artifact store and the side pane, so it is restricted to " +
          'characters that need no escaping anywhere ("build-log", "perf.p95").',
      );
      continue;
    }

    // Reuse across member categories (diagnosis 4): The diagnosis falls in the last place - the category that appears first is the established fact.
    const first = claimed.get(id);
    if (first === undefined) {
      claimed.set(id, site);
      declared.push({ id, kind: site.op });
    } else if (first.op !== site.op) {
      push(
        ARTIFACT_DECLARATION_CODE,
        site.loc,
        `artifact id "${id}" is used with two different kinds: artifact.${first.op} on line ` +
          `${first.loc.line} and artifact.${site.op} here. Within one run an id belongs to exactly ` +
          "one kind — publishing it again is what mints the next VERSION, and a version cannot " +
          "change what the thing is. Give this one its own id.",
      );
    }

    // Unique deliverable (9009): The diagnosis falls on the `primary` attribute of the last place - the one marked first is the existing fact.
    const primaryNode = primaryLiteralOf(site);
    if (primaryNode !== undefined) {
      if (primaryClaim === undefined) primaryClaim = { id, site };
      else if (primaryClaim.id !== id) {
        push(
          ARTIFACT_PRIMARY_CONFLICT_CODE,
          locOf(primaryNode),
          `artifact "${id}" is marked primary, but "${primaryClaim.id}" already is (artifact.` +
            `${primaryClaim.site.op} on line ${primaryClaim.site.loc.line}). A run has one ` +
            "deliverable — the card and the run pane lead with it. Drop primary from one of them, " +
            "or publish this content as a new version of the other id.",
        );
      }
    }

    // Improved diagnostics (exclusive to preset families): Content members **often** appear in loops/conditions where they should (one release per round,
    // Make up a new edition if it fails), so this clause must not be extended to that family.
    if (isArtifactPresetOp(site.op)) {
      const context = hoistingContextOf(site.call, body);
      if (context !== undefined) {
        push(ARTIFACT_HOISTING_CODE, site.loc, HOISTING_MESSAGE[context]);
      }
    }
  }

  // The declared **preset** id (the legal target set of the tag) and the content id are separated into two tables: the tag pointing to the content id has a dedicated
  // A piece of copywriting (it's not "there is no such thing", but "this thing has no data surface").
  const presetIds = declared.filter((entry) => isArtifactPresetOp(entry.kind)).map((e) => e.id);
  const contentIds = new Set(
    declared.filter((entry) => !isArtifactPresetOp(entry.kind)).map((e) => e.id),
  );

  for (const site of table.reports) {
    if (site.artifactIdExpr === undefined) continue; // Unlabeled reports continue as usual
    const tagLoc = locOf(site.artifactIdExpr);
    if (site.artifactId === undefined) {
      push(
        ARTIFACT_DECLARATION_CODE,
        tagLoc,
        "report()'s artifact tag must be a compile-time string literal naming a preset artifact " +
          "declared in this script: the tag is how an item finds its dashboard, and a tag that only " +
          "exists at run time cannot be checked against the declarations. Write the id inline.",
      );
      continue;
    }
    const tag = site.artifactId;
    if (presetIds.includes(tag)) continue;
    if (contentIds.has(tag)) {
      push(
        ARTIFACT_DECLARATION_CODE,
        tagLoc,
        `report()'s tag "${tag}" names a file/markdown artifact, which holds content rather than a ` +
          "stream of items — there is nothing for this item to become. Tag the item with a preset " +
          "artifact (chart / table / metrics / board), or drop the tag and let the item go to the " +
          "run's Results.",
      );
      continue;
    }
    push(
      ARTIFACT_DECLARATION_CODE,
      tagLoc,
      `report()'s tag "${tag}" names no preset artifact declared in this script${describePresets(presetIds)}. ` +
        'Declare it first — artifact.chart("' +
        tag +
        '", { x, y }) at the top of the script — or drop the tag.',
    );
  }

  return { declaredArtifacts: sortDeclared(declared), diagnostics };
}

/**
 * The property written literally as `primary: true` among the site opts / spec arguments; absent, not an object literal, or not a
 * literal `true` (computed, or spread in) all count as absent — that half is left to the engine.
 */
function primaryLiteralOf(site: ArtifactSite): ts.Node | undefined {
  const arg = site.call.arguments[isArtifactPresetOp(site.op) ? 1 : 2];
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return undefined;
  for (const property of arg.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
    if (key !== "primary") continue;
    return property.initializer.kind === ts.SyntaxKind.TrueKeyword ? property : undefined;
  }
  return undefined;
}

/** The tail of "the declared presets are: …"; when there are none, it says so more plainly. */
function describePresets(presetIds: readonly string[]): string {
  if (presetIds.length === 0) return " (this script declares no preset artifacts at all)";
  return ` (declared presets: ${[...presetIds].sort().map((id) => `"${id}"`).join(", ")})`;
}

/** Deduplicated (same id + same kind keeps one entry) and sorted by id. */
function sortDeclared(declared: readonly DeclaredArtifact[]): DeclaredArtifact[] {
  const seen = new Set<string>();
  const unique: DeclaredArtifact[] = [];
  for (const entry of declared) {
    const key = `${entry.id} ${entry.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.sort((a, b) => (a.id === b.id ? a.kind.localeCompare(b.kind) : a.id < b.id ? -1 : 1));
}

/**
 * Which kind of position this call **lexically** belongs in that it should not belong in, walking outward from the call to the script body; undefined when it is none of them.
 * The innermost one is reported: it is closest to the line the author has to change, and the wording is the most specific.
 *
 * An ordinary function declaration is deliberately **not** counted as a callback: `function setup() { artifact.chart(...) }` followed by one
 * `setup()` is a legitimate top-level declaration, just written differently. Arrow functions and function expressions, on the other hand, are almost always callbacks
 * (`.map(...)`, `.then(...)`), so they do count. The cost is an under-report for the shape "declared inside a named helper that the loop calls" — that is the
 * under-report direction, consistent with this module's conservative stance (the engine's
 * `ArtifactRedeclared` still backstops it).
 */
function hoistingContextOf(call: ts.CallExpression, body: ts.Block): HoistingContext | undefined {
  let child: ts.Node = call;
  for (let node: ts.Node | undefined = call.parent; node !== undefined; node = node.parent) {
    if (node === body) return undefined;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      return "callback";
    }
    if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      return "loop";
    }
    // if / ternary: Only **branch** counts the conditional position, the conditional expression itself does not count - `if (artifact.chart(...))`
    // The problem with unconditional evaluation is something else (a void is used as a condition), and this article should not be used to explain it.
    if (ts.isIfStatement(node) && (node.thenStatement === child || node.elseStatement === child)) {
      return "conditional";
    }
    if (ts.isConditionalExpression(node) && (node.whenTrue === child || node.whenFalse === child)) {
      return "conditional";
    }
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return "conditional";
    child = node;
  }
  return undefined;
}
