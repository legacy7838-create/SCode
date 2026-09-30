import ts from "typescript";

/**
 * The **literal cardinality** of a fan-out:
 * when the iterated expression is an array literal with no spread elements, or a `const` bound to such a
 * literal that is only initialized once and never written to, the cardinality = the literal's length;
 * everything else is `undefined`.
 *
 * This is **mint-time** work (interpret.ts): it needs the AST and the checker, while the projection is not
 * allowed to look at code again.
 * The principle is better absent than wrong: anything uncertain yields absent, and the handoff graph then
 * draws a `many` card instead of guessing a number.
 */
export function literalCardinality(iterated: ts.Expression, checker: ts.TypeChecker): number | undefined {
  const expr = unwrap(iterated);
  if (ts.isArrayLiteralExpression(expr)) return spreadFreeLength(expr);
  if (!ts.isIdentifier(expr)) return undefined;

  const symbol = checker.getSymbolAtLocation(expr);
  const decl = symbol?.valueDeclaration;
  if (symbol === undefined || decl === undefined || !ts.isVariableDeclaration(decl)) return undefined;
  if (!ts.isIdentifier(decl.name)) return undefined;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return undefined;
  if (decl.initializer === undefined) return undefined;
  const init = unwrap(decl.initializer);
  if (!ts.isArrayLiteralExpression(init)) return undefined;
  const length = spreadFreeLength(init);
  if (length === undefined) return undefined;
  return isEverWritten(symbol, decl.getSourceFile(), checker) ? undefined : length;
}

/** `(xs)`, `xs as const`, `xs!`, `xs satisfies T` are all the same array. */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isTypeAssertionExpression(current)) current = current.expression;
    else return current;
  }
}

function spreadFreeLength(literal: ts.ArrayLiteralExpression): number | undefined {
  if (literal.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element))) {
    return undefined;
  }
  return literal.elements.length > 0 ? literal.elements.length : undefined;
}

/** Methods that change the array's contents in place: a binding that has been through them is no longer a literal length. */
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "length"]);

/**
 * Whether that binding has been written: in-place methods such as `xs.push(…)`, `xs[i] = …` / `xs[i]++`,
 * `xs.length = 0`, and (though `const` already forbids it) assignment to the name itself. Aliases
 * (`const ys = xs; ys.push()`) and passing the array into a function are out of scope: only these three kinds
 * of write are checked, since shapes beyond them would yield an answer other than absent anyway.
 */
function isEverWritten(symbol: ts.Symbol, file: ts.SourceFile, checker: ts.TypeChecker): boolean {
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    if (ts.isIdentifier(node) && node.parent !== undefined && checker.getSymbolAtLocation(node) === symbol) {
      if (isWriteReference(node)) written = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return written;
}

function isWriteReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  // The statement itself is not written.
  if (ts.isVariableDeclaration(parent) && parent.name === id) return false;
  // xs.push(...) / xs.length = 0
  if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
    const name = parent.name.text;
    if (!MUTATORS.has(name)) return false;
    if (name === "length") return isAssignmentTarget(parent);
    return ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
  }
  // xs[i] = ... / xs[i]++ / delete xs[i]
  if (ts.isElementAccessExpression(parent) && parent.expression === id) return isAssignmentTarget(parent);
  // xs = ... (wrong type under const, but still counts)
  return isAssignmentTarget(id);
}

function isAssignmentTarget(node: ts.Expression): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    const op = parent.operatorToken.kind;
    return op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  if (ts.isDeleteExpression(parent)) return true;
  // Destructuring assignment target: [xs[0]] = ... / ({ a: xs[0] } = ...)
  if (ts.isArrayLiteralExpression(parent) || ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
    let up: ts.Node = parent;
    while (ts.isArrayLiteralExpression(up) || ts.isObjectLiteralExpression(up) || ts.isPropertyAssignment(up) || ts.isShorthandPropertyAssignment(up) || ts.isSpreadElement(up)) {
      up = up.parent;
    }
    return ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.EqualsToken && up.left !== undefined && containsNode(up.left, node);
  }
  return false;
}

function containsNode(root: ts.Node, target: ts.Node): boolean {
  return target.pos >= root.pos && target.end <= root.end;
}
