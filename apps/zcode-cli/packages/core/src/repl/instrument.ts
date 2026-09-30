import { parseModule, type ESTree } from "meriyah";

/**
 * The pure functions that instrument REPL code (route B: top-level bindings persist across calls).
 *
 * The design motivation: To support top-level await, NodeReplSession wraps user code in `(async () => {...})()`, which
 * makes top-level `const/let/var/function/class` be captured by the IIFE's local scope and never land in
 * the persistent vm context. Here meriyah parses out the top-level declarations and injects `globalThis.<name> = <name>;`
 * after each declaration statement, copying the bindings into the persistent context so that a
 * bare name in the next `js` call resolves to globalThis through the scope chain.
 *
 * This module is the A-ready seam: should `--experimental-vm-modules` ever let us move up to
 * SourceTextModule (route A), only the executor is replaced and a harvest-flavored instrument is written anew,
 * while `parseReplCode`/`collectTopLevelBindingNames` are reused as-is (swapping the parser implementation only touches the inside of parseReplCode).
 */

/** The parseReplCode result: on success it carries the AST, on failure parseError (it does not throw, the caller falls back). */
type ParseReplCodeResult = { ast: ESTree.Program } | { parseError: Error };

/**
 * Parse REPL code into an ESTree AST. It wraps meriyah.parseModule (swapping the parser implementation only touches here = the
 * A-ready seam). Module mode plus next buys the latest syntax; ranges give every node start/end (the instrument slicing needs
 * it). A parse failure returns { parseError } and never throws (the caller falls back to executing the code as-is).
 */
export function parseReplCode(code: string): ParseReplCodeResult {
  try {
    const ast = parseModule(code, { next: true, ranges: true });
    return { ast };
  } catch (error) {
    return { parseError: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Recursively collect every identifier name declared inside a binding pattern.
 * Covers: Identifier / ObjectPattern (shorthand and RestElement included) / ArrayPattern (holes and
 * RestElement included) / AssignmentPattern (defaults) / RestElement.
 */
function collectPatternNames(node: ESTree.Node | null | undefined, out: string[]): void {
  if (!node) {
    // The elision in ArrayPattern is null and skipped.
    return;
  }
  switch (node.type) {
    case "Identifier":
      out.push(node.name);
      return;
    case "ObjectPattern":
      for (const prop of node.properties) {
        // meriyah actually produces RestElement/Property in the pattern context, but the type annotation is wider
        // (ObjectLiteralElementLike contains SpreadElement), so it is narrowed one by one according to type.
        const p = prop as ESTree.Node;
        if (p.type === "RestElement") {
          collectPatternNames(p.argument, out);
        } else if (p.type === "Property") {
          // The destructuring target is value (xx of `{x:xx}`; value of shorthand `{x}` is also x).
          collectPatternNames(p.value as ESTree.Node, out);
        } else if (p.type === "SpreadElement") {
          // Defensive: Rarely, when a pattern is marked as SpreadElement, its arguments are also collected.
          collectPatternNames(p.argument as ESTree.Node, out);
        }
      }
      return;
    case "ArrayPattern":
      for (const el of node.elements) {
        collectPatternNames(el, out);
      }
      return;
    case "AssignmentPattern":
      // `const {x = 1} = o` / `const [a = 1] = arr`: Binding name is on left.
      collectPatternNames(node.left, out);
      return;
    case "RestElement":
      collectPatternNames(node.argument, out);
      return;
    default:
      // Non-declared targets such as MemberExpression (destructuring and assigning to existing properties) do not generate new bindings and are ignored.
      return;
  }
}

/** Collect every binding name declared by a single top-level declaration statement (for the instrument to inject statement by statement). */
function collectStatementBindingNames(node: ESTree.Node): string[] {
  const names: string[] = [];
  if (node.type === "VariableDeclaration") {
    for (const decl of node.declarations) {
      collectPatternNames(decl.id, names);
    }
  } else if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    if (node.id) {
      names.push(node.id.name);
    }
  }
  return names;
}

/**
 * Rewrite a dynamic import() in the cell into the injected importModule().
 * vm.Script cannot execute an import expression directly by default, so the executor uses the host loader
 * and replaces only the real ImportExpressions in the AST; strings, comments and import.meta are unaffected.
 */
function rewriteDynamicImports(code: string, ast: ESTree.Program): string {
  const starts: number[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { type?: unknown; start?: unknown; range?: unknown };
    if (node.type === "ImportExpression") {
      const start =
        typeof node.start === "number"
          ? node.start
          : Array.isArray(node.range) && typeof node.range[0] === "number"
            ? node.range[0]
            : undefined;
      if (start !== undefined) starts.push(start);
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(ast);
  let rewritten = code;
  for (const start of starts.sort((left, right) => right - left)) {
    rewritten = `${rewritten.slice(0, start)}importModule${rewritten.slice(start + "import".length)}`;
  }
  return rewritten;
}

/**
 * Rewrite the dynamic import with REPL syntax. User code may use a top-level return, which the module parser rejects; when direct
 * parsing fails, the code is temporarily wrapped in an async function only to obtain a reliable AST range, and the wrapper is
 * stripped afterwards. That avoids falling back to regex replacement and avoids mangling an `import(` that lives in a string or a comment.
 */
export function rewriteDynamicImportsForRepl(code: string): string {
  const direct = parseReplCode(code);
  if ("ast" in direct) return rewriteDynamicImports(code, direct.ast);

  const prefix = "(async () => {\n";
  const suffix = "\n})";
  const wrapped = `${prefix}${code}${suffix}`;
  const wrappedParsed = parseReplCode(wrapped);
  if (!("ast" in wrappedParsed)) return code;
  const rewritten = rewriteDynamicImports(wrapped, wrappedParsed.ast);
  return rewritten.slice(prefix.length, rewritten.length - suffix.length);
}

/** Get a node's end offset; with ranges:true end always exists, and the default is a fallback that sidesteps a type-narrowing problem. */
function nodeEnd(node: ESTree.Node): number {
  const end = node.end ?? node.range?.[1];
  if (end === undefined) {
    throw new Error("instrument needs the node end (parseReplCode should pass ranges:true)");
  }
  return end;
}

/** Get a node's start offset; the sibling of nodeEnd, used to slice the completion value of the last expression statement. */
function nodeStart(node: ESTree.Node): number {
  const start = node.start ?? node.range?.[0];
  if (start === undefined) {
    throw new Error("instrument needs the node start (parseReplCode should pass ranges:true)");
  }
  return start;
}

/**
 * Copy the bindings into the persistent context after each top-level declaration, and turn the last expression
 * statement into a return so the cell's completion value can be handed back. Statement-by-statement injection guarantees that when a later statement throws, the declarations that ran before the throw still survive.
 */
export function instrumentForContextPersistence(code: string, ast: ESTree.Program): string {
  let cursor = 0;
  let out = "";
  const lastIndex = ast.body.length - 1;
  ast.body.forEach((stmt, index) => {
    // The last top-level expression statement: Convert to return and let async-IIFE return the completion value (REPL echo).
    // Declaration/control flow statements are not transferred (its completion value is undefined, and the REPL semantics are consistent).
    if (index === lastIndex && stmt.type === "ExpressionStatement") {
      const stmtStart = nodeStart(stmt);
      const stmtEnd = nodeEnd(stmt);
      // meriyah's expression range for `({ value: 1 })` does not contain the outermost bracket.
      // Inserting return from expression.start produces `(return ({...});)` illegal syntax; must end with complete
      // ExpressionStatement is the boundary and only the semicolon at the end of the statement is removed.
      const expressionSource = code.slice(stmtStart, stmtEnd).replace(/;\s*$/, "");
      // Keep the original trivia (blank/comment) before the statement, and wrap the complete expression in return (...).
      out += code.slice(cursor, stmtStart);
      out += `return (${expressionSource});`;
      cursor = nodeEnd(stmt);
      return;
    }
    const end = nodeEnd(stmt);
    // Keep the original fragment up to the end of the statement (including leading whitespace/comments and the statement itself).
    out += code.slice(cursor, end);
    cursor = end;
    const names = collectStatementBindingNames(stmt);
    if (names.length > 0) {
      const assigns = names.map((name) => `globalThis.${name}=${name};`).join("");
      out += `;${assigns}`;
    }
  });
  // Keep the trailing original fragment after the last statement.
  out += code.slice(cursor);
  return out;
}
