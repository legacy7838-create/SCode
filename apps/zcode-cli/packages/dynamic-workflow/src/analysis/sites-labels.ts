import ts from "typescript";
import { FACADE_FILE_NAME } from "../facade/dts.js";
import type { WorldReadOp } from "../facade/registry.js";
import type { ScriptLoc } from "../compiler/compile.js";
import type { NamePattern } from "./types.js";
import type { CallbackSemantics } from "./callbacks.js";
import type { IterationCandidate } from "./sites.js";

// sites.ts reaches the oxlint max-lines limit (400 lines), and adds name/tag auxiliary (ask tag and template
// shapes, actor names and template shapes, world-read tags, literal literals, iteration candidate constructs, counters) and their dependencies
// Symbol resolution (resolveSymbol / isFacadeDeclared) is split into this file; the public side is still exported from sites.ts (the latter two
// Export it there as it is, and the rest will not be made public). Site types stay in sites.ts, here they are only imported by type.

/** Resolve a node's symbol, following one alias hop (imports never occur here). */
export function resolveSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

/** True iff any of the symbol's declarations lives in the facade `.d.ts`. */
export function isFacadeDeclared(symbol: ts.Symbol | undefined): boolean {
  return (
    symbol?.declarations?.some(
      (declaration) => declaration.getSourceFile().fileName === FACADE_FILE_NAME,
    ) ?? false
  );
}

/**
 * The text of an argument that is a **hole-free string literal**; everything else (an identifier, a
 * template with holes, an arbitrary expression) is uniformly undefined.
 *
 * Three places share this one determination: a phase's name, an artifact's id, and a report's label.
 * The rules for all three are exactly the same — only a literal closed at compile time counts, and
 * anything that cannot be seen through is left to its own diagnostic pass to locate by the original
 * expression, and **a value is never guessed here** (a guessed name would let a call that should
 * have been taught a rewrite pass silently). `ts.isStringLiteralLike` covers a backtick string with
 * no interpolation.
 */
export function literalText(expr: ts.Expression | undefined): string | undefined {
  return expr !== undefined && ts.isStringLiteralLike(expr) ? expr.text : undefined;
}

export class Counter {
  private value = 0;
  next(): number {
    this.value += 1;
    return this.value;
  }
}

/**
 * ask label: an inline `agent("name", …)` receiver contributes its literal name;
 * a plain identifier receiver contributes its text; otherwise `"ask"`.
 */
export function askLabel(receiver: ts.Expression, checker: ts.TypeChecker): string {
  if (ts.isCallExpression(receiver) && isActorCall(receiver, checker)) {
    const first = receiver.arguments[0];
    if (first !== undefined && ts.isStringLiteralLike(first)) return first.text;
  }
  if (ts.isIdentifier(receiver)) return receiver.text;
  return "ask";
}

/**
 * ask label pattern: only for an inline `` agent(`researcher${i}`) `` receiver — the one shape
 * `askLabel` answers `"ask"` for despite the script having said something. A named or
 * identifier receiver already produced a real label, so there is nothing to reconstruct.
 */
export function askLabelPattern(
  receiver: ts.Expression,
  checker: ts.TypeChecker,
): NamePattern | undefined {
  if (!ts.isCallExpression(receiver) || !isActorCall(receiver, checker)) return undefined;
  return templateAffixes(receiver.arguments[0]);
}

function isActorCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (ts.isPropertyAccessExpression(call.expression)) return false;
  const symbol = resolveSymbol(call.expression, checker);
  return isFacadeDeclared(symbol) && symbol?.name === "agent";
}

/**
 * actor name: a string-literal first argument, else the binding name when the call
 * directly initializes a variable declaration, else undefined.
 */
export function actorName(call: ts.CallExpression): string | undefined {
  const first = call.arguments[0];
  if (first !== undefined && ts.isStringLiteralLike(first)) return first.text;
  const parent = call.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === call &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return undefined;
}

/**
 * actor name pattern: the static shape of a first argument that is a template literal
 * with holes. Only consulted when `actorName` came back undefined — a literal name and a
 * binding name are both real names, and a pattern must never displace one.
 */
export function actorNamePattern(call: ts.CallExpression): NamePattern | undefined {
  return templateAffixes(call.arguments[0]);
}

/**
 * The literals at both ends of a template string: before the first hole (`head`) and after the last
 * hole (`tail`).
 *
 * `ts.isStringLiteralLike` already covers a backtick string with no interpolation (that is a literal
 * and goes down the `name` path), so only a genuinely hole-bearing `ts.TemplateExpression` is handled
 * here.
 *
 * **The literal in the middle is deliberately dropped**: `` `a${x}b${y}c` `` yields `a` and `c`, not
 * `a…b…c`. A name is the label on the line, not a rendering of the expression that produced it.
 */
function templateAffixes(arg: ts.Expression | undefined): NamePattern | undefined {
  if (arg === undefined || !ts.isTemplateExpression(arg)) return undefined;
  const head = meaningfulAffix(arg.head.text);
  const tail = meaningfulAffix(arg.templateSpans.at(-1)?.literal.text);
  if (head === undefined && tail === undefined) return undefined;
  return {
    ...(head === undefined ? {} : { head }),
    ...(tail === undefined ? {} : { tail }),
  };
}

/**
 * Whether an affix is worth displaying: after trimming it must contain at least one letter or digit.
 *
 * Why this gate: the tail of `` agent(`${x}-`) `` is `-`, which renders as `…-` — worse than an
 * unnamed agent, since the reader gets no name and a string of punctuation besides. `\p{L}` covers
 * CJK, so a purely CJK name still passes as usual.
 */
function meaningfulAffix(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  return /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : undefined;
}

/** world-read label: the op name, plus a string-literal first argument when present. */
export function worldReadLabel(op: WorldReadOp, arg: ts.Expression | undefined): string {
  if (arg !== undefined && ts.isStringLiteralLike(arg)) return `${op} ${arg.text}`;
  return op;
}

export function eachCandidate(
  call: ts.CallExpression,
  semantics: CallbackSemantics,
  order: number,
  loc: ScriptLoc,
): IterationCandidate | undefined {
  const index = semantics.callbacks[0];
  const argument = index === undefined ? undefined : call.arguments[index];
  const iterated = semantics.iterated;
  if (argument === undefined || iterated === undefined) return undefined;
  const literal = ts.isArrowFunction(argument) || ts.isFunctionExpression(argument);
  return {
    body: literal ? argument.body : argument,
    ...(literal ? { callback: argument } : { callbackExpr: argument }),
    call,
    element: literal ? argument.parameters[semantics.elementParams?.[0] ?? 0]?.name : undefined,
    form: "array-method",
    iterated,
    loc,
    method: semantics.label,
    order,
    semantics,
  };
}

export function forOfCandidate(
  statement: ts.ForOfStatement,
  order: number,
  loc: ScriptLoc,
): IterationCandidate {
  let element: ts.BindingName | undefined;
  if (ts.isVariableDeclarationList(statement.initializer)) {
    element = statement.initializer.declarations[0]?.name;
  }
  return {
    body: statement.statement,
    element,
    form: "for-of",
    iterated: statement.expression,
    loc,
    order,
  };
}
