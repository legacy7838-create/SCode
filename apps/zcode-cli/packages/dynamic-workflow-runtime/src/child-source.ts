/**
 * Sandbox child process logic. **One implementation, one entry file, two ways to launch it**:
 *   - {@link renderChildEntry} renders {@link childMain} together with the payload via `toString()` into a
 *     self-contained ESM, which the harness writes to `<cwd>/.zcode/workflow-runs/<runId>.mjs` (child-entry-file.ts);
 *   - plain Node: `node --max-old-space-size=N <entry>`, and the entry file self-starts when it finds that it is
 *     the process entry point;
 *   - SEA single-file binary: the CLI's hidden subcommand `__zcode-dwf-child <entry>` `import()`s this file and
 *     calls the `start(deps)` it exports, injecting the CLI process's vm/readline/stdio (the SEA main program does not
 *     interpret Node CLI flags, so the `--eval` route does not work).
 *
 * Windows' command line limit is 32,767 characters, and
 * `--eval CHILD_SOURCE -- <base64url payload>` puts the whole lowered script on the command line, so as soon as a script passes roughly 18 KB it fails with `spawn ENAMETOOLONG` and on Windows every slightly longer run fails to start.
 *
 * Structure:
 *   - The outer realm ({@link childMain} itself) is plain Node code: it owns stdio, readline and vm, and is
 *     responsible for transport.
 *   - The evaluation unit is a **separate realm** created by `vm.createContext(...)`: it holds only the ES intrinsics plus
 *     the injected `__host`. A bare vm context naturally has no `process`/`require`/`Buffer`/`fetch`; we add only `__host`
 *     and the runtime bans.
 *
 * Cross-realm convergence (guarding against prototype leaks / prototype pollution): everything the script touches
 * (Promises, host results parsed from JSON, Errors) is constructed **inside the context**; there are only two kinds of value crossing the boundary between the outer realm and the context — a single `__send(string)` outer function, and the inbound line strings (strings are primitives with no realm ownership). So `Array.isArray`/`instanceof`/the prototype chain are all context-native from the script's point of view, never mixed with the outer realm's intrinsics.
 *
 * Dynamic import: runFn is compiled via `vm.runInContext` (a Script, with no importModuleDynamically callback supplied),
 * so a runtime `import()` throws `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. `eval`/`Function` are bound to the same set of
 * context globals.
 *
 * ⚠ This file is a **hand-written mirror** of the wire protocol in protocol.ts: the childMain in the entry file runs as an
 * embedded string and cannot import protocol.ts. A change to either place must be mirrored in the other. So {@link childMain}
 * is allowed to import **types** only (erased at compile time) and must never introduce a runtime package dependency.
 */

import type { ChildPayload } from "./protocol.js";

/** The entire `node:vm` surface used by {@link childMain} (narrow enough to be just two functions — that is the child process's vm contract). */
export interface ChildVmModule {
  createContext(sandbox: object, options?: { name?: string }): object;
  runInContext(code: string, sandbox: object, options?: { filename?: string }): unknown;
}

/** The `readline.Interface` surface used by {@link childMain}. */
export interface ChildReadlineInterface {
  on(event: "line", listener: (line: string) => void): unknown;
  close(): void;
}

/**
 * The host capabilities injected into {@link childMain}. **Each of the two launch paths provides a real implementation**:
 * the self-starting entry file takes them from `node:vm` / `node:readline` / `process`, and the SEA subcommand takes them from the CLI process, both on the spot.
 */
export interface ChildMainDeps {
  vm: ChildVmModule;
  createInterface(options: { input: NodeJS.ReadableStream }): ChildReadlineInterface;
  /** The source of inbound responses (the parent process's stdin pipe). Holding it also keeps the event loop alive. */
  stdin: NodeJS.ReadableStream;
  /** Where outbound NDJSON goes; {@link childMain} supplies the newlines itself. */
  stdout: { write(chunk: string): unknown };
  /**
   * This run's payload ({@link import("./protocol.js").ChildPayload}). The entry file embeds it as a JSON literal and passes
   * it in as-is — no longer via argv, no longer base64.
   */
  payload: ChildPayload;
}

/**
 * The sandbox child process's **only** exit. The returned promise settles after the script execution ends (complete has been sent, stdin is closed).
 *
 * Why it must be awaitable: the SEA subcommand runs inside the CLI process, and the CLI entry installs a 1s exit watchdog
 * after `run()` returns (scheduleCliExitWatchdog in shutdown.ts). If the child process logic merely "wires up readline and returns synchronously", the watchdog will hard-kill the whole child process right as the run starts. The self-starting entry file does not need this promise (an empty event loop exits by itself), but both entries share one implementation, so childMain uniformly provides the termination signal.
 *
 * ⚠ The self-contained constraint (load-bearing, not a style question). {@link renderChildEntry} embeds this function as
 * **source** via `childMain.toString()`, so the function body must be a program that stands on its own; two rules:
 *   1. Reference only the parameters, language intrinsics and Node globals such as `Buffer`, and **never any binding
 *      from module scope** (constants, helper functions, imports). The sandbox bootstrap is therefore inlined in the
 *      function body rather than being a module-level constant.
 *   2. **Inner functions must never be named** — for the reason and the bug that bit here, see the comment in the
 *      function body (esbuild's `minify + keepNames` puts a module-scope `__name` helper on them).
 * Both constraints have to be verified under the real bundling/minification shape; source-level tests alone cannot catch
 * this class of regression.
 */
export function childMain(deps: ChildMainDeps): Promise<void> {
  /**
   * The bootstrap script that runs inside the vm context (plain JS, no backticks / ${}, so that it embeds safely). It defines
   * `__host` (Boundary A shims), `__deliver` (consumes inbound responses), `__execute` (runs the lowered fn), and imposes the
   * runtime bans (Date.now / argless new Date() / Math.random) — belt; the compile-time diagnostics are the suspenders.
   */
  const BOOTSTRAP = String.raw`
"use strict";

var __nextLocal = 0;
var __nextReq = 0;
var __pending = new Map();

function __emit(obj) {
  __send(JSON.stringify(obj));
}

function __createActor(siteId, name, persona) {
  // Synchronously create the child-local handle and forget about create-actor; the parent process completes the mapping according to stdio FIFO before subsequent ask.
  var localId = "local#" + (++__nextLocal);
  __emit({ kind: "create-actor", localId: localId, siteId: siteId, name: name, persona: persona });
  return localId;
}

function __ask(siteId, actor, instructions) {
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "ask", siteId: siteId, actor: actor, instructions: instructions });
  });
}

function __worldRead(siteId, op, args) {
  // args is a lowering packaged positional parameter group; this shim is transparently transmitted as it is, without looking at the op or verifying the arity (owned by the driver).
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "world-read", siteId: siteId, op: op, args: args });
  });
}

function __log(message) {
  __emit({ kind: "event", type: "log", message: String(message) });
}

function __enterPhase(name) {
  // Stage mark: No site, no journal, only let the engine send one event - so go through the event channel with the log.
  __emit({ kind: "event", type: "phase-entered", name: String(name) });
}

function __publishArtifact(siteId, op, args) {
  // The content artifact is an effect: the script awaits it and can catch its rejection, so go with ask / world-read
  // request/response. args is lowering packed positional parameters ([id, path|content, opts]), which are passed through as they are.
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "publish-artifact", siteId: siteId, artifactOp: op, args: args });
  });
}

function __declareArtifact(siteId, op, args) {
  // The preset product is a statement: void is returned synchronously, there is nothing to wait for, so the event channel is used. It shares the same clause with report
  // FIFO - A tagged report must arrive at the parent process later than its declaration, and order is guaranteed by this.
  __emit({ kind: "event", type: "declare-artifact", siteId: siteId, op: op, args: args });
}

function __report(siteId, item, artifactId) {
  // Fire and forget: the script never awaits it, so goes through the event channel instead of request/response. Parent process by siteId ×
  // ordinal falls into a line of journal, so the **arrival order** of this message is load-bearing (stdio FIFO guarantees it).
  // If there is a loop in item, the JSON.stringify here will throw an error - at the call point of report(), the script will either catch
  // Or let run fail. Both are better than silently emitting a complete item; the parent process has the same guardrails.
  // In the absence of artifactId, JSON.stringify directly discards the key, so there is "no tag" online.
  __emit({ kind: "event", type: "report", siteId: siteId, item: item, artifactId: artifactId });
}

// ——Run actual parameters (args of Boundary A)——
// Like the budget, it is constructed using JSON.parse within the context, so the script gets the context-native object.
// The outer realm's intrinsics are not incorporated at all (cross-realm convergence constraints at the top of this document).
// ⚠ Object.freeze is a **shallow** freeze: nested objects are not frozen, and scripts can still modify args.foo.bar. v1 accept this
// Boundary - it blocks "hand-sliding reassignment of args", not a safety boundary (the actual parameters are originally given by the caller).
var __args = Object.freeze(JSON.parse(__argsJson));

globalThis.__host = {
  args: __args,
  createActor: __createActor,
  ask: __ask,
  worldRead: __worldRead,
  publishArtifact: __publishArtifact,
  declareArtifact: __declareArtifact,
  report: __report,
  log: __log,
  enterPhase: __enterPhase,
};

// ——Inbound response consumption (called by the outer realm as a line string)——
globalThis.__deliver = function (line) {
  var msg = JSON.parse(line);
  if (msg.kind !== "response") return;
  var waiter = __pending.get(msg.id);
  if (!waiter) return;
  __pending.delete(msg.id);
  if (msg.ok) {
    waiter.resolve(msg.value);
    return;
  }
  // Reject out-of-bounds context-native Error and bring code/violations/finalText for script try/catch structured processing.
  var e = msg.error || {};
  var err = new Error(e.message || "workflow host error");
  if (e.name) err.name = e.name;
  if (e.code !== undefined) err.code = e.code;
  if (e.violations !== undefined) err.violations = e.violations;
  if (e.finalText !== undefined) err.finalText = e.finalText;
  waiter.reject(err);
};

function __complete(ok, payload) {
  if (ok) {
    __emit({ kind: "complete", ok: true, value: payload });
    return;
  }
  var wire;
  if (payload instanceof Error) {
    wire = {
      name: payload.name,
      message: payload.message,
      stack: payload.stack,
      code: payload.code,
      violations: payload.violations,
      finalText: payload.finalText,
    };
  } else {
    wire = { name: "Error", message: String(payload) };
  }
  __emit({ kind: "complete", ok: false, error: wire });
}

// The outer realm calls it to run scripts; it always resolves (the error has been converted into a complete message), which facilitates the outer finishing (turning off stdin).
globalThis.__execute = async function (runFn) {
  try {
    var value = await runFn(globalThis.__host);
    __complete(true, value);
  } catch (e) {
    __complete(false, e);
  }
};

// —— Runtime bans (belt; compile diagnostics are suspenders): Date.now / argless new Date() / Math.random ——
var __NativeDate = Date;
class __WorkflowDate extends __NativeDate {
  constructor() {
    if (arguments.length === 0) throw new Error("argless new Date() is disabled in workflows");
    super(...arguments);
  }
  static now() {
    throw new Error("Date.now() is disabled in workflows");
  }
  static parse(value) {
    return __NativeDate.parse(value);
  }
  static UTC() {
    return __NativeDate.UTC.apply(__NativeDate, arguments);
  }
}
globalThis.Date = __WorkflowDate;
Math.random = function () {
  throw new Error("Math.random() is disabled in workflows");
};
`;

  // ⚠ The second self-contained constraint (see the comment above the function) is easier to ignore than "don't import": **Inner functions must not have names**.
  // Root cause (I actually stepped on it before writing this test): CLI's desktop-agent is built with `minify + keepNames`,
  // In that combination, esbuild will **infer the name** of the inner function (variable declaration `const send = ...`, function declaration,
  // Object literal attribute) is rewritten as `__name(fn, "send")`, and `__name` is a helper injected in the module scope.
  // Once it appears in the text of `toString()`, the embedded subprocess program will raise ReferenceError——**Only in compressed
  // There are bad bugs in the released product, and the source code tests are all green. Member assignment (`sandbox.__send = ...`) and anonymous functions in actual parameter positions are not overridden.
  // Therefore, these two forms will be used below. During verification, you need to run the actual packaged and compressed product.

  const payload = deps.payload;

  // Independent realm: bare context only has ES intrinsics, injected __send transmission + actual parameter JSON.
  // Absent arguments (inline run, old journal lines) are encoded as "{}": `args` is always defined as a script-side invariant,
  // This side of the sandbox is where it's set up.
  const sandbox = {
    __argsJson: JSON.stringify(payload.args ?? {}),
  } as {
    __send: (line: string) => void;
    __argsJson: string;
    __deliver: (line: string) => void;
    __execute: (runFn: unknown) => Promise<void>;
  };
  sandbox.__send = (line) => {
    deps.stdout.write(`${line}\n`);
  };
  deps.vm.createContext(sandbox, { name: "workflow-sandbox" });
  deps.vm.runInContext(BOOTSTRAP, sandbox, { filename: "workflow-bootstrap.js" });

  // Compile lowered function body (context-native async fn; its await generates context Promise, import() without callback will throw an error).
  let runFn: unknown;
  try {
    runFn = deps.vm.runInContext(`(async (__host) => {\n${payload.lowered}\n})`, sandbox, {
      filename: "workflow-script.js",
    });
  } catch (error) {
    // Lowered body compilation fails: terminate directly after sending error-complete. Deliberately **not** call process.exit - written to the pipeline
    // stdout is asynchronous, and exiting immediately will truncate the complete message just issued (the parent process will only see "exited without completion" instead.
    // Throw away SyntaxError details). At this time, there is no reader in the event loop, and the child process will exit naturally after flushing.
    const err = error as { name?: string; message?: string; stack?: string } | undefined;
    deps.stdout.write(
      `${JSON.stringify({
        kind: "complete",
        ok: false,
        error: {
          name: err?.name ?? "SyntaxError",
          message: err?.message ?? String(error),
          stack: err?.stack,
        },
      })}\n`,
    );
    return Promise.resolve();
  }

  // stdin keeps the event loop alive; each line is fed to the context's __deliver.
  const reader = deps.createInterface({ input: deps.stdin });
  reader.on("line", (line: string) => {
    if (!line.trim()) return;
    sandbox.__deliver(line);
  });

  // Run the script; close stdin at the end, and the process will naturally exit with the idle event loop (the parent process will also be killed after receiving complete).
  return sandbox.__execute(runFn).then(
    () => reader.close(),
    () => reader.close(),
  );
}

/** Everything outside the safe character set for runId in the entry file name is replaced with `_` (the file name and the header comment share the same sanitization). */
function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Renders the sandbox entry file: a self-contained ESM, which the harness writes to disk and launches with `node <entry>`.
 *
 * Contents: the payload as a JSON literal (the output of `JSON.stringify` is a valid JS expression), the {@link childMain}
 * embedded via `toString()`, the exported `start(deps)`, and two pieces of top-level logic:
 *   - Best-effort heap cap: the default path is taken by the real flag `--max-old-space-size`; SEA cannot pass flags when
 *     re-execing, so `v8.setFlagsFromString` is used only when `execArgv` does not have it (the effect is not guaranteed,
 *     the same as on the atomic command side);
 *   - Self-start detection: when `realpath(argv[1])` is the same path as this file (`node <entry>`), it self-starts with the
 *     process's vm/readline/stdio; when it is `import()`ed by the SEA subcommand the check is false and the subcommand calls
 *     `start`. Comparing realpath rather than the bare path: macOS's tmpdir is symlinked via `/var → /private/var`, and
 *     `import.meta.url` is the resolved real path, so a bare comparison would silently keep the child process from starting.
 *
 * The only interpolations are childMain's source text and the payload JSON. childMain itself carrying template literals is
 * not a problem — interpolation is **runtime string concatenation**, and the embedded text is not parsed a second time; the real risk lives on childMain's self-contained constraint side (see its comment). The generated top-level code deliberately avoids template literals so it does not collide with the outer `${}`.
 */
export function renderChildEntry(payload: ChildPayload, meta: { runId: string }): string {
  const runId = safeRunId(meta.runId);
  return `// zcode dynamic workflow run ${runId}
// Generated by @zcode/dynamic-workflow-runtime before every launch; safe to delete once the run has settled.
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import vm from "node:vm";

export const payload = ${JSON.stringify(payload)};

const main = ${childMain.toString()};

export const start = (deps) => main({ ...deps, payload });

if (
  typeof payload.maxOldSpaceSizeMb === "number" &&
  Number.isFinite(payload.maxOldSpaceSizeMb) &&
  payload.maxOldSpaceSizeMb > 0 &&
  !process.execArgv.some((arg) => arg.startsWith("--max-old-space-size"))
) {
  try {
    setFlagsFromString("--max-old-space-size=" + Math.trunc(payload.maxOldSpaceSizeMb));
  } catch {
    // best-effort: V8 may no longer pay attention to flags that have been consumed during the startup period, and failure shall not affect the run.
  }
}

let isProcessEntry = false;
try {
  isProcessEntry =
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isProcessEntry = false;
}
if (isProcessEntry) {
  void start({ vm, createInterface, stdin: process.stdin, stdout: process.stdout });
}
`;
}
