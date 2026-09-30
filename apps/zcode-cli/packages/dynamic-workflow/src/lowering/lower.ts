import ts from "typescript";
import {
  collectDiagnostics,
  createWorkflowProgram,
  WORKFLOW_FUNCTION_NAME,
  type CompileDiagnostic,
  type WorkflowProgram,
} from "../compiler/compile.js";
import { FACADE_FILE_NAME } from "../facade/dts.js";
import { isArtifactPresetOp, type ArtifactOp, type WorldReadOp } from "../facade/registry.js";
import { collectFacadeMisuse } from "../analysis/facade-misuse.js";
import {
  collectSites,
  isFacadeDeclared,
  resolveSymbol,
  type SiteTable,
} from "../analysis/sites.js";

/**
 * Lowering (the instrumentation emit step): lowering a workflow script that has already passed typecheck +
 * analyze into sandbox-runnable
 * **JavaScript**. Two things:
 *
 *   1. Strip types: the program has already typechecked, so this is a transpile-level type erasure over the
 *      same source.
 *   2. Instrument every facade call with the **static site id** from the site table, rewriting it into
 *      Boundary A's `__host.*`:
 *        agent(name, persona)        -> __host.createActor("actor#2", name, persona)
 *        planner.ask<Plan>(text)     -> __host.ask("ask#3", planner, text)
 *        maybe?.ask<Plan>(text)      -> maybe === null || maybe === undefined
 *                                         ? undefined : __host.ask("ask#3", maybe, text)
 *                                       (the optional chain's short-circuit is preserved: when the receiver is
 *                                        nullish the ask is skipped and the arguments are not evaluated; a
 *                                        non-identifier receiver is evaluated once via a temporary variable)
 *        files.glob(p) / files.read(p)
 *                                    -> __host.worldRead("world-read#1", "glob", [p])
 *                                       __host.worldRead("world-read#2", "read", [p])
 *        report(x)                   -> __host.report("report#1", x)
 *        report(x, "perf")           -> __host.report("report#1", x, "perf")
 *        artifact.file(id, p, o)     -> __host.publishArtifact("artifact#1", "file", [id, p, o])
 *        artifact.chart(id, spec)    -> __host.declareArtifact("artifact#2", "chart", [id, spec])
 *        log(msg)                    -> __host.log(msg)
 *        phase("gate")               -> __host.enterPhase("gate") (no site; the engine emits a single event)
 *      Join (Promise.all) and fan-out are ordinary in-sandbox promise mechanisms, not host calls, and are kept
 *      as is.
 *
 * ————————————————————————————————————————————————————————————————
 * Output contract (the harness contract; the sandbox is responsible for the wrap):
 * ————————————————————————————————————————————————————————————————
 * {@link LoweredWorkflow.code} is the **async function body** of the lowered script: top-level `await` and a
 * trailing
 * `return <artifact>` are both legal, because the harness wraps it in an async function and runs it, of the
 * form
 *
 *     const __run = async (__host) => { <code> };
 *
 * In other words the only free identifier in code is `__host` (see {@link HOST_BINDING}): the facades
 * `agent` / `log` / `files` / `phase` have all been rewritten away, so the sandbox vm's globals
 * only need the ES intrinsics plus one `__host`.
 * A schema never crosses the sandbox boundary: the engine looks the schema up from the compiled artifact by
 * site id, and code contains no schema at all.
 *
 * {@link LoweredWorkflow.siteIds} is every instrumented facade site id, ordered by source (asks /
 * actors / world-reads / reports / artifacts; `log`/`phase` take no site id and so are not in it): it lets
 * the harness and tests assert that "each site id appears exactly once".
 *
 * Determinism: the printer and the transpile are both pure functions, so the same input -> byte-identical
 * output.
 */

/** The free identifier the harness must bind for the lowered code (Boundary A's host handle). */
export const HOST_BINDING = "__host";

/** The product of lowering: the JS body handed to the sandbox + the list of site ids instrumented into. */
export interface LoweredWorkflow {
  /** The async function body of the lowered script (top-level await / trailing return are legal; the only free identifier is `__host`). */
  code: string;
  /** The instrumented facade site ids, in source order (excluding log, which has no site id). */
  siteIds: string[];
}

/** The result of {@link lowerWorkflowScript}: isomorphic with analyze: a dirty script is not lowered, and `lowered` is only given when `ok`. */
export interface LowerResult {
  diagnostics: CompileDiagnostic[];
  ok: boolean;
  lowered?: LoweredWorkflow;
}

/** For each facade call registered in the site table, which `__host.*` it is rewritten into (`phase` has no site id, only a name). */
type SiteEmit =
  | { kind: "actor"; siteId: string }
  | { kind: "artifact"; siteId: string; op: ArtifactOp }
  | { kind: "ask"; siteId: string }
  /** Phase marker: no site id, only the name with the whitespace at both ends stripped (a marker whose name is absent falls back to `void 0`). */
  | { kind: "phase"; name: string | undefined }
  | { kind: "report"; siteId: string }
  | { kind: "world-read"; siteId: string; op: WorldReadOp };

/**
 * The convenience entry: compile + facade-siting validation + collecting the site table + lower, isomorphic
 * with `analyzeWorkflowScript`.
 * A dirty script (a typecheck or facade-siting error) is not lowered: lowering only runs on clean programs.
 */
export function lowerWorkflowScript(scriptText: string): LowerResult {
  const workflow = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  if (diagnostics.length > 0) return { diagnostics, ok: false };

  const table = collectSites(workflow);
  const misuse = collectFacadeMisuse(workflow, table);
  if (misuse.length > 0) return { diagnostics: misuse, ok: false };

  return { diagnostics, lowered: lowerWorkflow(workflow, table), ok: true };
}

/**
 * The core: lower a workflow that has already analyzed clean into {@link LoweredWorkflow}.
 * Site calls (ask/actor/world-read) are always matched by **ts.Node identity** (the raw call reference held
 * by the site table), never re-identified by name/shape, which would create a second source of truth. `log` is
 * not in the site table; it is identified through the checker's
 * signature resolution (resolved into the facade .d.ts, the same mechanism as sites.ts), which is
 * identity-based rather than a name heuristic.
 */
export function lowerWorkflow(workflow: WorkflowProgram, table: SiteTable): LoweredWorkflow {
  const checker = workflow.program.getTypeChecker();
  const siteMap = buildSiteMap(table);

  // First trip: instrumentation. Do transform on the same scriptFile (its node is referenced by the site table),
  // This allows the site table to be hit by node identity; the type has not yet been erased.
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const { factory } = context;
    const hostMember = (name: string): ts.Expression =>
      factory.createPropertyAccessExpression(factory.createIdentifier(HOST_BINDING), name);
    const siteArg = (id: string): ts.Expression => factory.createStringLiteral(id);

    const visit: ts.Visitor = (node) => {
      // `args` is the only **value** in the facade rather than a callable object, so it is the only one that is rewritten at the identifier level.
      // Symbol: Reading it is not a waiting point, there is no station, and it does not enter the cause and effect diagram. Determine the results of parsing by checker (with the site
      // Identity identity mechanism), so local `args` declared by the script itself are parsed into symbols of the script file and left intact.
      //
      // Deliberately **not** use "inject `const args = ...` in the wrapper function body" instead: declare another one in the user script
      // `args` will become a runtime SyntaxError of repeated declarations, which will be completely invisible at compile time.
      if (ts.isIdentifier(node) && node.text === "args" && isFacadeArgsRead(node, checker)) {
        return hostMember("args");
      }
      if (ts.isCallExpression(node)) {
        const emit = siteMap.get(node);
        if (emit !== undefined) return lowerSited(node, emit);
        // Non-site facade calls can only be log (agent/ask/glob/read must be a site and is in siteMap).
        const name = facadeCalleeName(node, checker);
        if (name === "log") {
          return factory.createCallExpression(
            hostMember("log"),
            undefined,
            node.arguments.map(visitExpr),
          );
        }
      }
      return ts.visitEachChild(node, visit, context);
    };

    const visitExpr = (expr: ts.Expression): ts.Expression =>
      ts.visitNode(expr, visit) as ts.Expression;

    const lowerSited = (call: ts.CallExpression, emit: SiteEmit): ts.Expression => {
      if (emit.kind === "phase") {
        // phase("gate") -> __host.enterPhase("gate"). The flag is still **no site, no journal line** - it's not a one-step job; but the control flow goes through
        // It needs to be visible to the engine (a `phase-entered` event), otherwise a phase with no nodes in the timeline
        // It's always an empty circle. The name is stripped of both ends and has the same key as the parser casting phase id; the name is absent (non-literal,
        // 9004 Diagnosis should have blocked first) returns `void 0` - free identifier `phase` must not remain in the sandbox.
        const name = emit.name?.trim();
        if (name === undefined || name.length === 0) return factory.createVoidZero();
        return factory.createCallExpression(hostMember("enterPhase"), undefined, [
          factory.createStringLiteral(name),
        ]);
      }
      if (emit.kind === "actor") {
        // agent(name?, persona?) -> __host.createActor(siteId, name?, persona?)
        return factory.createCallExpression(hostMember("createActor"), undefined, [
          siteArg(emit.siteId),
          ...call.arguments.map(visitExpr),
        ]);
      }
      if (emit.kind === "ask") {
        // receiver.ask<T>(instr) -> __host.ask(siteId, receiver, instr) (discarding type argument <T>).
        // facade-siting guarantees that ask must be directly called by `receiver.ask(...)`, so callee must be an attribute access.
        const access = call.expression as ts.PropertyAccessExpression;
        const receiver = visitExpr(access.expression);
        const loweredAsk = (recv: ts.Expression): ts.Expression =>
          factory.createCallExpression(hostMember("ask"), undefined, [
            siteArg(emit.siteId),
            recv,
            ...call.arguments.map(visitExpr),
          ]);
        if (!ts.isOptionalChain(call)) return loweredAsk(receiver);
        // ask(`p?.ask(x)`, `wrap?.p.ask(x)`) on optional chain cannot be unconditionally rewritten as
        // `__host.ask(siteId, <receiver>, x)` - short circuit to `?.` is discarded. When receiver is nullish
        // The semantics of the author's program is "skip this ask, the entire chain will result in undefined", and the downgraded product carries undefined
        // Called into the engine, it is judged that UnknownActor **fails the entire run** - and only occurs when the optional branch is really empty,
        // It might take an entire long run to burn before it explodes. Rewritten as nullish guard three eyes: the actual parameters are not evaluated when the guard hits.
        // The semantics are consistent with the optional chain primitive; the identifier receiver is read directly (no side effects), and the remaining expressions are hoisted
        // Temporary variables are evaluated exactly once - isomorphic to how tsc itself downgrades optional chains.
        const once = ts.isIdentifier(receiver)
          ? receiver
          : factory.createTempVariable(context.hoistVariableDeclaration);
        const evaluated = once === receiver ? receiver : factory.createAssignment(once, receiver);
        const isNullish = factory.createBinaryExpression(
          factory.createBinaryExpression(
            evaluated,
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createNull(),
          ),
          factory.createToken(ts.SyntaxKind.BarBarToken),
          factory.createBinaryExpression(
            once,
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createIdentifier("undefined"),
          ),
        );
        return factory.createConditionalExpression(
          isNullish,
          factory.createToken(ts.SyntaxKind.QuestionToken),
          factory.createIdentifier("undefined"),
          factory.createToken(ts.SyntaxKind.ColonToken),
          loweredAsk(once),
        );
      }
      if (emit.kind === "artifact") {
        // artifact.file(id, path, opts)  -> __host.publishArtifact(siteId, "file", [id, path, opts])
        // artifact.chart(id, spec)       -> __host.declareArtifact(siteId, "chart", [id, spec])
        // The two families have the same shape but different names: the names are different because the return types of the two paths are different (promise vs void), and
        // The engine dispatches by method name rather than by op - a script that awaits declarations as effects should be at the type level
        // It is blocked instead of getting an undefined at runtime. Actual participation in world-read is the same as: by position as is
        // Packed into an array, lowering does not look at the op, and does not check the arity (check the return engine and driver).
        const member = isArtifactPresetOp(emit.op) ? "declareArtifact" : "publishArtifact";
        return factory.createCallExpression(hostMember(member), undefined, [
          siteArg(emit.siteId),
          factory.createStringLiteral(emit.op),
          factory.createArrayLiteralExpression(call.arguments.map(visitExpr)),
        ]);
      }
      if (emit.kind === "report") {
        // report(item, artifactId?) -> __host.report(siteId, item, artifactId?)
        // report goes to **site mapping** instead of the following log path identified by checker name: it is
        // There is a site (journal press site × ordinal to remove duplicate replay), but the site identity is only in the site table.
        return factory.createCallExpression(hostMember("report"), undefined, [
          siteArg(emit.siteId),
          ...call.arguments.map(visitExpr),
        ]);
      }
      // files.glob(arg)/files.read(arg) -> __host.worldRead(siteId, op, [arg])
      // The actual parameters are packed into the array literal **as is according to position**: lowering does not look at the op, does not look at the arity, and does not do any verification. The arity and actual parameter verification of each op belong to the driver,
      // So adding a world-read primitive is zero change in this pass.
      return factory.createCallExpression(hostMember("worldRead"), undefined, [
        siteArg(emit.siteId),
        factory.createStringLiteral(emit.op),
        factory.createArrayLiteralExpression(call.arguments.map(visitExpr)),
      ]);
    };

    return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
  };

  const result = ts.transform(workflow.scriptFile, [transformer]);
  const transformed = result.transformed[0];
  if (transformed === undefined) throw new Error("lowering: transform produced no source file");

  // Only take the function body statement of __workflowScript__ (wrapper/facade/export will not enter lowered code).
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const instrumented = workflowBody(transformed)
    .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, transformed))
    .join("\n");
  result.dispose();

  // Second pass: type erasure. At this point, the piling has been completed and the node identity is no longer needed, so transpile-level erasure of the text can be done.
  const code = ts.transpileModule(instrumented, {
    compilerOptions: {
      isolatedModules: false,
      module: ts.ModuleKind.ESNext,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: false,
  }).outputText;

  return { code, siteIds: sourceOrderSiteIds(table) };
}

/**
 * The four kinds of site call in the site table plus the phase marker, built into a
 * `ts.CallExpression -> SiteEmit` map
 * (matched by node identity). phase goes through this map to obtain its node identity and name: it has no
 * site id, and therefore
 * does not enter {@link sourceOrderSiteIds}.
 */
function buildSiteMap(table: SiteTable): Map<ts.CallExpression, SiteEmit> {
  const map = new Map<ts.CallExpression, SiteEmit>();
  for (const site of table.actors) map.set(site.call, { kind: "actor", siteId: site.id });
  for (const site of table.artifacts) {
    map.set(site.call, { kind: "artifact", op: site.op, siteId: site.id });
  }
  for (const site of table.asks) map.set(site.call, { kind: "ask", siteId: site.id });
  for (const marker of table.phases) map.set(marker.call, { kind: "phase", name: marker.name });
  for (const site of table.reports) map.set(site.call, { kind: "report", siteId: site.id });
  for (const site of table.worldReads) {
    map.set(site.call, { kind: "world-read", op: site.op, siteId: site.id });
  }
  return map;
}

/** The instrumented site ids, in source order (the site table's global `order` discovery order). */
function sourceOrderSiteIds(table: SiteTable): string[] {
  const sited = [
    ...table.actors,
    ...table.artifacts,
    ...table.asks,
    ...table.reports,
    ...table.worldReads,
  ];
  return sited.sort((a, b) => a.order - b.order).map((site) => site.id);
}

/** Locates the __workflowScript__ function body statements after the transform (shaped like findWorkflowBody in sites.ts). */
function workflowBody(sourceFile: ts.SourceFile): ts.NodeArray<ts.Statement> {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === WORKFLOW_FUNCTION_NAME &&
      statement.body !== undefined
    ) {
      return statement.body.statements;
    }
  }
  throw new Error(`lowering: ${WORKFLOW_FUNCTION_NAME} not found in transformed source`);
}

/**
 * The name of the resolved facade callable (following the resolved signature's declaration, which lands inside
 * the facade .d.ts), otherwise undefined. It is the same idea as sites.ts's private facadeCalleeName:
 * identity determined by the signature declaration
 * rather than by the spelling of the callee expression, so a computed member access
 * (`files["read"](x)`) also resolves to the facade method.
 * This module only uses it to recognize log: site-kind facade calls have already matched in siteMap and
 * returned earlier, so they never reach here.
 */

/**
 * True iff this `args` identifier is a READ of the facade global (not a shadowing local,
 * not a property name, not a declaration site).
 *
 * Identity comes from the checker, exactly as facade call sites do: a script that writes
 * its own `const args = ...` resolves to a symbol declared in the script file, so it is
 * left alone and keeps shadowing benignly. The syntactic guards below are for positions
 * where an identifier is not a value read at all — `x.args`, `{ args: 1 }`, and the name
 * in `const args = ...` — where rewriting would produce nonsense like `{ __host.args: 1 }`.
 */
function isFacadeArgsRead(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent !== undefined) {
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isQualifiedName(parent) && parent.right === node) return false;
    if (
      (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) &&
      parent.name === node
    ) {
      return false;
    }
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
    // Declaration bit (`const args = ...`, parameter name, import name): That is creating a binding, not reading the facade.
    if (
      (ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent)) &&
      parent.name === node
    ) {
      return false;
    }
  }
  return isFacadeDeclared(resolveSymbol(node, checker));
}

function facadeCalleeName(call: ts.CallExpression, checker: ts.TypeChecker): string | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined || declaration.getSourceFile().fileName !== FACADE_FILE_NAME) {
    return undefined;
  }
  const name = (declaration as ts.FunctionDeclaration | ts.MethodSignature).name;
  return name !== undefined && ts.isIdentifier(name) ? name.text : undefined;
}
