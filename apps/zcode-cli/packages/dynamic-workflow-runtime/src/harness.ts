/**
 * The parent-process harness (the host side of Boundary A + sandbox subprocess orchestration).
 *
 * Responsibility: run a workflow script (or an already lowered function body) in a controlled subprocess, bridging the
 * subprocess's `__host.*` calls over NDJSON to a {@link WorkflowEngine} instance, and finally return the engine's
 * {@link RunSettlement}. This package depends **only** on `@zcode/dynamic-workflow` and the node builtins — proving that the whole
 * pipeline runs app-free, never importing `@zcode/core`/`@zcode/contracts`/`@zcode/bootstrap`/`@zcode/adapters`.
 *
 * Timeline (happy path):
 *
 *   parent                         child(vm)
 *     │  write <cwd>/.zcode/workflow-runs/<runId>.mjs (payload: lowered+args inlined)
 *     │  spawn(node <entry>)
 *     │──────────────────────────▶│  build __host in context
 *     │◀── create-actor(local#1) ──│  createActor returns local#1 synchronously
 *     │  map local#1 → ActorId     │
 *     │◀── request ask(local#1) ───│  await __host.ask(...)
 *     │  engine.ask → driver.startAsk … settle
 *     │── response(value) ────────▶│  resolve
 *     │◀────── complete(ok,value) ──│  script return
 *     │  engine.complete(value) → settled=completed
 *
 * Failure/cancellation: the verdict on a run belongs to the engine. Terminal failures (the script throwing error-complete, a
 * subprocess crash or non-zero exit, a wall-clock timeout, a JSON parse failure on a subprocess line) all call
 * `engine.fail(error)` (settle failed + journal failure_json); the abort signal is the only "true cancellation", calling
 * `engine.stop(initiator)` (settle stopped; a `signal.reason` of `"model"` means a main-agent TaskStop, `"interrupted"` means stopping
 * the runs it owns when the host App shuts down, anything else counts as the user). The engine's own run-level failures
 * (reportCap/inputHash/unknownActor) likewise surface through engine.settled. The harness-side first-wins finalize only handles
 * subprocess cleanup (clearing timers, closing stdin, killing the child); it never fabricates a settlement.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import {
  lowerWorkflowScript,
  WorkflowEngine,
  WorkflowError,
  type ActorId,
  type AskSpec,
  type Caps,
  type ImportedRunCache,
  type RunSettlement,
  type ValidateFn,
  type WorkflowDriver,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { type ChildMessage, type ChildPayload, type ResponseMessage } from "./protocol.js";
import { renderChildEntry } from "./child-source.js";
import { writeChildEntryFile, type HarnessWarning } from "./child-entry-file.js";

/** The driver factory: the harness first builds the sink (the engine's upward reporting surface), hands it to the factory to build the driver, then builds the engine with that driver. */
export type DriverFactory = (sink: WorkflowReportSink) => WorkflowDriver;

/**
 * The run's **live control surface**: after the engine is constructed, the harness hands this incarnation's engine to it, so the side
 * holding the handle (the run service) can reach the living engine. There is only one command today — changing the concurrency
 * ceiling of this run in place.
 *
 * Narrowed to `Pick<…, "setMaxConcurrency">` instead of the whole engine: the control surface is a **command** channel, not a back
 * door letting the host bypass the harness to drive the run lifecycle (settlement still goes only through complete/stop/fail).
 *
 * Following the same rule as `signal`: the harness only wires things up, it does not interpret, validate or backstop; the liveness
 * check and the no-op semantics of a command live entirely in the engine (`setMaxConcurrency` returning false means this call
 * changed nothing).
 */
export interface RunControlBinding {
  bind(engine: Pick<WorkflowEngine, "setMaxConcurrency">): void;
}

/**
 * The arguments of {@link runWorkflowScript}. The executable body comes from `scriptText` or `lowered` (the latter wins); giving
 * both is exactly the "compile once" shape — the caller compiles to get `lowered` itself while handing down the author's
 * `scriptText` to be persisted.
 *
 * **The harness never validates whether that pair is consistent**: it cannot (deciding whether `lowered` really was lowered from
 * `scriptText` means running the compilation a second time, which is precisely the one run "compile once" exists to save). Hand in
 * a mismatched combination and the persisted `script_text` disagrees with the code that actually ran, which skews the comparison
 * basis for resume — that consistency belongs to the caller.
 */
export interface RunWorkflowOptions {
  /**
   * The source of the workflow script as written by the author, with two uses:
   * 1. when `lowered` is absent, the harness lowers it to get the executable body;
   * 2. **always** persisted as run metadata into `dwf_run.script_text` (the comparison basis for resume is the author's
   *    original text, not the lowered function body).
   */
  scriptText?: string;
  /**
   * An already lowered async function body (`__host` is the only free identifier). It bypasses the compiler and goes straight
   * into the sandbox — security tests use it to feed hand-written lowered bodies (the vm contract itself is what is under test),
   * and the compile-once path uses it to hand over the product of its own single compilation. When given, it takes precedence over
   * `scriptText` as the executable body.
   */
  lowered?: string;
  runId?: string;
  /** The driver factory (see {@link DriverFactory}). The driver brings its own journal and emit. */
  makeDriver: DriverFactory;
  caps: Caps;
  /** The static spec of each ask site. **It must cover every ask site in the script** — the engine treats an absence as a wiring error and fails hard. */
  askSpecs: ReadonlyMap<string, AskSpec>;
  /** The injected schema validator (the engine does not import a schema implementation). */
  validate: ValidateFn;
  /** The external cancellation signal: it aborts the in-flight ask and kills the subprocess; the run settles as cancelled. */
  signal?: AbortSignal;
  /**
   * The binding point of the live control surface (see {@link RunControlBinding}). It is handed in through the same seam as
   * `signal`: that one is the "stop this run" channel, this one is the "change one setting of this run" channel. Its absence
   * means this launch has no control surface (e.g. snippet execution).
   */
  control?: RunControlBinding;
  /** The wall-clock timeout (ms): when it expires the subprocess is killed and the run settles as failed. Absent means no limit. */
  timeoutMs?: number;
  /** The subprocess heap ceiling (MB), mapped onto `--max-old-space-size`. Defaults to 256. */
  maxOldSpaceSizeMb?: number;
  /**
   * The alternative form of the subprocess spawn strategy: when given, spawns `process.execPath [...argsPrefix, <entry path>]`,
   * **with no Node CLI flags at all**.
   *
   * The reason it exists: a SEA single-file binary does not interpret Node CLI flags, and the default path's
   * `--max-old-space-size` lands in the CLI's strict parseArgs as an ordinary token and then inevitably errors out and exits (every
   * workflow run fails under SEA). Under SEA, bootstrap passes a hidden subcommand name as argsPrefix, and the subprocess
   * re-execs this binary and `import()`s the entry file and calls its `start` before parseArgs.
   *
   * The price: the heap ceiling can only be applied by the entry file itself with a best-effort `v8.setFlagsFromString`.
   */
  childSpawn?: { argsPrefix: readonly string[] };
  /**
   * The reporting point for non-fatal conditions (today there is exactly one: the entry file could not be written into the
   * project's `.zcode/` and fell back to the OS temp directory). The harness is app-free and has no logger; bootstrap
   * connects it to its own warn log.
   */
  onWarning?: (warning: HarnessWarning) => void;
  /** The subprocess working directory, process.cwd() by default; also persisted as run metadata into dwf_run.cwd. */
  cwd?: string;
  /**
   * Run metadata, forwarded **verbatim** to `EngineConfig` (createRun persists it into dwf_run). Everything is optional and the
   * harness neither transforms nor infers anything: `scriptHash` is **computed by the caller**. If the harness hashed "the text
   * it sees", what gets persisted on the lowered path is the hash of the lowered function body — resume validation would then
   * get a silently wrong comparison target. The original script text goes through `scriptText` above.
   */
  scriptHash?: string;
  parentSessionId?: string;
  /** The display name of the run (the label source for the host-side enumeration surface). Like `scriptText`, the harness only forwards it. */
  name?: string;
  /**
   * The arguments of this run (the declarative parameters of a saved workflow, already validated and defaulted by the caller).
   *
   * **Two destinations**, which is what distinguishes it from the rest of the metadata: it both goes to `dwf_run.args_json` with
   * `EngineConfig` (resume reads it back from there to replay) and enters the spawn payload, is injected into the sandbox and
   * becomes the frozen `args` global. The harness neither validates nor transforms it — declaration and validation both belong to
   * the caller (the tool side). Absent means `{}`.
   */
  args?: Record<string, unknown>;
  /** The CreateWorkflow tool call id that launched the run (the join/notification anchor after a restart); forwarded verbatim to EngineConfig. */
  toolCallId?: string;
  /**
   * The pair of arguments for an amended resume (amend-resume), following the same rule as the rest of the metadata: **forwarded
   * verbatim to EngineConfig**, the harness neither reads, transforms nor infers anything. `resumedFrom` is the lineage pointer
   * persisted into `dwf_run.resumed_from`, and `importedCache` is the pure-data cache table injected into the engine.
   *
   * The same division of labour as the `scriptText`/`lowered` pair: **their consistency belongs to the caller**. The harness
   * cannot tell whether this table really was built from that predecessor run (that would require it to read the journal itself,
   * and this package does not even know about storage). Hand in a table that does not match and what you get is a run that
   * treats someone else's answers as its own cache. Both the building and the gate live in the run
   * service (bootstrap's dynamic-workflow-import.ts).
   */
  resumedFrom?: string;
  /**
   * The anchor of the turn that launched the run; forwarded verbatim to EngineConfig.
   * `subagentModel` rides along with the anchor and the phase table: the canonical picker string for this run's subagents
   * (`providerId/modelId[$reasoningLevel]`), which the harness likewise neither reads, parses nor transforms — it lives with zero SQL
   * in the `run-launched` event, and both parsing and precedence are on the host side (bootstrap's workflow-actor-model.ts).
   * `phaseAlongside` and `phaseNames` line up by position (the index points into the same table), and follow the same rule.
   */
  launch?: {
    inputId: string;
    phaseNames?: string[];
    subagentModel?: string;
    phaseAlongside?: number[][];
  };
  importedCache?: ImportedRunCache;
  /**
   * The usage starting point when the run is created (the predecessor run's `spentTokens`); following the same rule as the rest of
   * the metadata: **forwarded verbatim to EngineConfig**, the harness neither reads nor transforms it. Reading the predecessor's
   * row happens in the run service.
   */
  inheritedTokens?: number;
}

const DEFAULT_MAX_OLD_SPACE_MB = 256;
const STDERR_LIMIT = 64 * 1024;

/**
 * Run a workflow script through to settlement. Returns the engine's {@link RunSettlement}.
 * Failure is a first-class citizen, but in two classes: the script throwing is the script's fault,
 * normalized to `{status:"errored", error}`; the subprocess failing to start / crashing / hitting the wall-clock timeout / corrupting
 * the protocol is a host-side fault that a rerun will likely fix, normalized to `{status:"stopped", reason:"interrupted", error}`
 * (resumable). Neither is ever silently swallowed.
 */
export async function runWorkflowScript(options: RunWorkflowOptions): Promise<RunSettlement> {
  const lowered = resolveLowered(options);
  const runId = options.runId ?? "run";

  // Sink late binding: The engine is constructed after the driver, but the driver requires the sink to return - use a forward proxy to break the ring dependency.
  let engine!: WorkflowEngine;
  const sink: WorkflowReportSink = {
    askSubmitAttempted: (instance, payload) => engine.askSubmitAttempted(instance, payload),
    askTurnEnded: (instance, finalText) => engine.askTurnEnded(instance, finalText),
    askProgress: (instance, progress) => engine.askProgress(instance, progress),
    askStats: (instance, stats) => engine.askStats(instance, stats),
    askFailed: (instance, error) => engine.askFailed(instance, error),
    // Deterministic model side error → the entire run stops, again just forwarding.
    stopRun: (error) => engine.stopRun(error),
    // The three pure observations and run-level stall observations of adaptive concurrency are also just forwarding.
    askWaiting: (instance, info) => engine.askWaiting(instance, info),
    askExecuting: (instance) => engine.askExecuting(instance),
    // The only observation that causes the engine to make decisions (about import caching) is again just forwarding.
    askMutating: (instance) => engine.askMutating(instance),
    concurrencyChanged: (change) => engine.concurrencyChanged(change),
    runStalled: (info) => engine.runStalled(info),
  };
  const driver = options.makeDriver(sink);
  engine = new WorkflowEngine({
    runId,
    driver,
    caps: options.caps,
    askSpecs: options.askSpecs,
    validate: options.validate,
    // Metadata verbatim transfer, default remains absent (undefined key is not implemented). cwd is actually used by the child process
    // are the same value, so the bottom line of process.cwd() is also recorded here - the cwd dropped in the library is the directory where run actually runs.
    ...(options.scriptText === undefined ? {} : { scriptText: options.scriptText }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.args === undefined ? {} : { args: options.args }),
    ...(options.scriptHash === undefined ? {} : { scriptHash: options.scriptHash }),
    ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
    ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
    ...(options.resumedFrom === undefined ? {} : { resumedFrom: options.resumedFrom }),
    ...(options.launch === undefined ? {} : { launch: options.launch }),
    ...(options.importedCache === undefined ? {} : { importedCache: options.importedCache }),
    ...(options.inheritedTokens === undefined ? {} : { inheritedTokens: options.inheritedTokens }),
    cwd: options.cwd ?? process.cwd(),
  });
  // The control surface is tied as soon as it is constructed: run can be changed from the first event without having to wait for the child process to come up - the following one
  // The failed spawn path is also resolved by the engine, and the handle is still safe after that (the command's own settled decision is responsible for closing).
  options.control?.bind(engine);

  const maxOldSpaceSizeMb = options.maxOldSpaceSizeMb ?? DEFAULT_MAX_OLD_SPACE_MB;
  const cwd = options.cwd ?? process.cwd();
  const payload: ChildPayload = {
    lowered,
    // Actual parameters only cross the bounds once at startup (constant during the run life cycle).
    ...(options.args === undefined ? {} : { args: options.args }),
    // The upper limit of the heap comes with the payload entry file and only serves the argsPrefix path: there is no Node flag to pass on that path.
    // The entry file can only be set by best-effort yourself. The default path is taken into effect by the true flag, and the entry file is skipped when it sees the flag.
    maxOldSpaceSizeMb,
  };

  // The payload is limited to the command line: the Windows command line limit is 32,767 characters, and the entire lowered script is about 18 KB.
  // Just `spawn ENAMETOOLONG`. Written as an entry file,
  // argv leaves only one path, the length of which is independent of the script size.
  let child: ChildProcess;
  try {
    const entry = writeChildEntryFile({
      cwd,
      runId,
      source: renderChildEntry(payload, { runId }),
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    });
    child = spawn(
      process.execPath,
      options.childSpawn === undefined
        ? [`--max-old-space-size=${maxOldSpaceSizeMb}`, entry.path]
        : [...options.childSpawn.argsPrefix, entry.path],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        // The desktop agent is run by the Electron Helper (process.execPath points to the Helper), while the CLI
        // ELECTRON_RUN_AS_NODE will be sanitized from its own env during startup. If you do not bring it explicitly, the child process will press the complete
        // Electron/Chromium application starts and gets stuck on GPU initialization - always silent and never exits, run gets stuck on run-started.
        // This variable is invalid under pure Node's execPath and has no side effects (same processing as official-plugin-runtime.ts).
        // Both spawn strategies must be carried: the desktop packaging state may also use the argsPrefix path.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
  } catch (cause) {
    // Node only converts EACCES/EAGAIN/EMFILE/ENFILE/ENOENT into error
    // event, the remaining spawn failed (ENAMETOOLONG, E2BIG...) **synchronous throw**. At this point the engine has been constructed and the journal line has been
    // running is dropped; letting the exception pop up directly will bypass the engine settlement - the registry is recorded as final, but the journal line is forever
    // running, subsequent resume_from was rejected by "has not settled yet". The entry file cannot be written (both directories are
    // Failure) in the same way. All resolved by the engine stopped (interrupted): Host side failure, can be resumed.
    const message = cause instanceof Error ? cause.message : String(cause);
    engine.stop(
      "interrupted",
      new WorkflowError("Interrupted", `Could not start the workflow sandbox process: ${message}`, {
        cause,
      }),
    );
    return engine.settled;
  }

  return bridge({ child, engine, runId, signal: options.signal, timeoutMs: options.timeoutMs });
}

/** Resolve the lowered body: prefer `lowered`, otherwise lower `scriptText` (a dirty script throws, without starting a subprocess). */
function resolveLowered(options: RunWorkflowOptions): string {
  if (options.lowered !== undefined) return options.lowered;
  if (options.scriptText === undefined) {
    throw new Error("runWorkflowScript: pass either scriptText or lowered");
  }
  const result = lowerWorkflowScript(options.scriptText);
  if (!result.ok || result.lowered === undefined) {
    const detail = result.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join("; ");
    throw new Error(
      `runWorkflowScript: the script failed compilation/analysis and is not run degraded: ${detail}`,
    );
  }
  return result.lowered.code;
}

interface BridgeDeps {
  child: ChildProcess;
  engine: WorkflowEngine;
  /** Used only for the error text in the abort normalization (the "interrupted" branch has to name which run was shut down). */
  runId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * NDJSON bridging and lifetime convergence. Single-writer finalize: whether it is reached from an engine settlement, a subprocess
 * exit, a timeout or an abort, the first one to arrive wins, then kills the subprocess and delivers the result.
 */
function bridge(deps: BridgeDeps): Promise<RunSettlement> {
  const { child, engine, runId, signal, timeoutMs } = deps;

  // Mapping of local#N (child-local handle) → engine ActorId; stdio FIFO + synchronous create-actor handling guarantees
  // The map is ready before any ask that references a handle arrives.
  const actorMap = new Map<string, ActorId>();
  let stderr = "";
  let finalized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: Interface | undefined;

  return new Promise<RunSettlement>((resolve) => {
    const finalize = (settlement: RunSettlement): void => {
      if (finalized) return;
      finalized = true;
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      reader?.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolve(settlement);
    };

    // Termination failures (script throw error/subprocess crash/timeout/protocol damage) are all run failures: handed over to the engine's public fail(),
    // By its first-wins settlement, driver-side cancellation on the fly ask, journal record failed + failure_json——run verdict
    // Owned by the engine, the journal does not diverge from the results seen by the caller. Child process cleanup is handled by finalize (via engine.settled).
    const failRun = (error: WorkflowError): void => {
      if (finalized) return;
      engine.fail(error);
    };
    // Host-side failure (sandbox crash/timeout/protocol damage): stopped (interrupted), can be resumed.
    const interruptRun = (message: string, cause?: unknown): void => {
      if (finalized) return;
      engine.stop(
        "interrupted",
        new WorkflowError("Interrupted", message, cause === undefined ? undefined : { cause }),
      );
    };

    // abort is the only "true cancellation": go to engine.stop(initiator) and settle stopped. initiator
    // `AbortController.abort(reason)` comes from: literal "model", amend path
    // `{ superseded: newRunId }` (successor id will be stored with the same reason), literal "interrupted" (host App
    // Close, see below), the rest are all "user".
    function onAbort(): void {
      if (finalized) return;
      const reason: unknown = signal?.reason;
      const supersededBy = readSupersededBy(reason);
      if (supersededBy !== undefined) {
        engine.stop("superseded", undefined, supersededBy);
        return;
      }
      // The host actively stops the run it owns (close() of run service). It is not user cancelled: Failed encoding with Interrupted dropped library, with timeout /
      // Sandbox crashes are in the same family - stopped(interrupted) can be resumed, while stopped(user) is read on the UI as
      // "The user pressed stop". The error text names the run and the cause, and the details page will interpret this line according to it the next time it is activated.
      if (reason === "interrupted") {
        engine.stop(
          "interrupted",
          new WorkflowError(
            "Interrupted",
            `dynamic workflow run ${runId} was interrupted: the owning session closed before the run settled`,
          ),
        );
        return;
      }
      engine.stop(reason === "model" ? "model" : "user");
    }

    // All settlements (complete/fail/stop/engine internal cap failure) emerge to finalize through engine.settled.
    void engine.settled.then(finalize);

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        interruptRun(
          `The workflow sandbox process exceeded its wall-clock timeout of ${timeoutMs}ms`,
        );
      }, timeoutMs);
      timer.unref?.();
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = trimTail(stderr + chunk.toString("utf8"), STDERR_LIMIT);
    });
    // There may still be a response to be written after the child process exits: hang error monitoring on stdin to prevent EPIPE from causing uncaught exceptions.
    child.stdin?.on("error", () => undefined);

    reader = createInterface({ input: child.stdout! });
    reader.on("line", (line) => {
      if (line.trim().length === 0) return;
      let message: ChildMessage;
      try {
        message = JSON.parse(line) as ChildMessage;
      } catch (cause) {
        // Child process line JSON corruption: exposed instead of swallowed.
        interruptRun(
          `The workflow sandbox process emitted a line that is not valid NDJSON: ${line}`,
          cause,
        );
        return;
      }
      handleChildMessage(message, { engine, actorMap, child, failRun });
    });

    child.on("error", (error) => {
      interruptRun(`Could not start the workflow sandbox process: ${error.message}`, error);
    });

    child.on("close", (code, sig) => {
      if (finalized) return;
      // Child process exited but engine not settled: crashed/killed without complete. Attributed to stderr.
      const reason =
        stderr.trim().length > 0
          ? stderr.trim()
          : `The workflow sandbox process exited (code=${code}, signal=${sig}) before completing`;
      interruptRun(reason);
    });
  });
}

interface MessageDeps {
  engine: WorkflowEngine;
  actorMap: Map<string, ActorId>;
  child: ChildProcess;
  failRun: (error: WorkflowError) => void;
}

/** Dispatch one child→parent message. ask/world-read are bridged asynchronously to the engine and answer with a response (carrying the latest budget). */
function handleChildMessage(message: ChildMessage, deps: MessageDeps): void {
  const { engine, actorMap, child, failRun } = deps;

  switch (message.kind) {
    case "create-actor": {
      // Synchronous processing: the mapping is established before any ask that refers to the handle (stdio FIFO prerequisite). createActor is purely synchronous,
      // If the run has been settled, an error will be thrown synchronously - there is no response channel at this time, and the run will be classified as a failure after capture (mostly a harmless ending race condition).
      try {
        const actorId = engine.createActor(
          message.siteId,
          message.name,
          message.persona as string | undefined,
        );
        actorMap.set(message.localId, actorId);
      } catch (cause) {
        failRun(
          cause instanceof WorkflowError
            ? cause
            : new WorkflowError("DriverError", `createActor failed at site ${message.siteId}`, {
                cause,
              }),
        );
      }
      return;
    }
    case "event":
      // Synchronous dispatch, consistent with log: the FIFO order of the event channel is load-bearing for both report and declare-artifact
      // (The journal of the parent process is what arrives, and a tagged report must be dropped later than its declaration),
      // Asynchronization decouples arrival order from journal order.
      if (message.type === "report") {
        engine.report(message.siteId, message.item, message.artifactId);
      } else if (message.type === "declare-artifact") {
        engine.declareArtifact(message.siteId, message.op, message.args);
      } else if (message.type === "phase-entered") {
        engine.enterPhase(message.name);
      } else {
        engine.log(message.message);
      }
      return;
    case "complete":
      if (message.ok) {
        engine.complete(message.value);
      } else {
        // The script throws an error: run failed (error details come from the sandbox).
        const err = message.error;
        failRun(
          new WorkflowError("DriverError", err?.message ?? "The workflow script threw an error", {
            cause: err?.stack ?? err?.name,
          }),
        );
      }
      return;
    case "request":
      handleRequest(message, { engine, actorMap, child, failRun });
      return;
    default: {
      const _exhaustive: never = message;
      void _exhaustive;
    }
  }
}

/** Bridge one host call that needs an answer (ask / world-read) to the engine, and return a response after settling. */
function handleRequest(
  message: Extract<ChildMessage, { kind: "request" }>,
  deps: MessageDeps,
): void {
  const { engine, actorMap, child } = deps;

  const respond = (ok: boolean, value: unknown, error?: WorkflowError): void => {
    const response: ResponseMessage = {
      kind: "response",
      id: message.id,
      ok,
      ...(ok ? { value } : { error: toWireError(error) }),
    };
    // The child process may have exited (cancelled/failed to end): only write when writable, I/O races such as EPIPE are swallowed at this boundary (run is already settling).
    const stdin = child.stdin;
    if (stdin === null || !stdin.writable) return;
    stdin.write(`${JSON.stringify(response)}\n`, () => undefined);
  };

  let promise: Promise<unknown>;
  if (message.type === "ask") {
    const actorId = actorMap.get(message.actor ?? "");
    if (actorId === undefined) {
      // Missing mapping (should not happen: FIFO guarantee) - normalization to UnknownActor structured rejection, not silent.
      respond(
        false,
        undefined,
        new WorkflowError("UnknownActor", `Unknown subagent handle: ${message.actor}`),
      );
      return;
    }
    promise = engine.ask(message.siteId, actorId, message.instructions ?? "");
  } else if (message.type === "publish-artifact") {
    const op = message.artifactOp;
    if (op === undefined) {
      // The missing op is a wiring error (lowering always fill it in). **Do not program a default value**: one is treated as file
      // Markdown publishing, errors will appear far away from the point of failure. Normalized into structured rejection, the script is visible.
      respond(
        false,
        undefined,
        new WorkflowError(
          "DriverError",
          `publish-artifact request is missing artifactOp (site ${message.siteId})`,
        ),
      );
      return;
    }
    promise = engine.publishArtifact(message.siteId, op, message.args ?? []);
  } else {
    // Op/args are passed to the engine as is: this layer does not look at ops and does not check arity (that is the responsibility of the driver). Missing args are normalized to an empty array,
    // Let the driver's argument validation loudly reject it instead of quietly coding a default value here.
    promise = engine.worldRead(message.siteId, message.op ?? "read", message.args ?? []);
  }

  promise.then(
    (value) => respond(true, value),
    (cause: unknown) => {
      const error =
        cause instanceof WorkflowError
          ? cause
          : new WorkflowError(
              "DriverError",
              cause instanceof Error ? cause.message : String(cause),
              { cause },
            );
      respond(false, undefined, error);
    },
  );
}

/** WorkflowError → the wire form (code/violations/finalText are kept, so sandbox scripts can handle it structurally in try/catch). */
function toWireError(error: WorkflowError | undefined): ResponseMessage["error"] {
  if (error === undefined) return { name: "Error", message: "unknown error" };
  const wire: NonNullable<ResponseMessage["error"]> = {
    name: error.name,
    message: error.message,
    code: error.code,
  };
  if (error.violations !== undefined) wire.violations = error.violations;
  if (error.finalText !== undefined) wire.finalText = error.finalText;
  return wire;
}

/** Keep the content within the last `limit` bytes of a string (stderr truncation). */
function trimTail(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return value.slice(-limit);
}

/** When the abort reason is `{ superseded: <runId> }`, extract the successor id; any other shape returns undefined. */
function readSupersededBy(reason: unknown): string | undefined {
  if (typeof reason !== "object" || reason === null) return undefined;
  const value = (reason as { superseded?: unknown }).superseded;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
