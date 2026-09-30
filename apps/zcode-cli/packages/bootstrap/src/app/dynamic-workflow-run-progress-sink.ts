/**
 * Workflow run progress events -> the parent session's append sink (create-app's `onRunEvent` is exactly that).
 *
 * Being its own file rather than staying inside create-app's closure is what lets the three **degradation paths** below be
 * unit-tested directly: all of them belong to the "run in flight, observation side failing" class, and letting an
 * exception escape any one of them would take down a run that is currently executing — while the truth about a run
 * lives in the journal, the progress surface is only an observer and must never be able to terminate it.
 */

import type { DynamicWorkflowRunProgressPayload, Logger, SessionId } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";

interface DynamicWorkflowRunProgressSinkDeps {
  /** Lazily obtains the runtime: the run service is already built **before** the runtime is constructed (it is one of the runtime's dependencies). */
  getRuntime: () => AgentRuntime;
  /** The session this app belongs to. A run's parentSessionId must equal it, see the identity gate below. */
  sessionId: SessionId;
  logger?: Logger;
}

/**
 * Builds a progress sink. The returned function **never throws and never returns a rejected promise**.
 *
 * ## Identity gate (load-bearing)
 *
 * Events must land in **the session that started the run**. Today that is a 1:1 which holds by construction:
 *
 *   ZCodeApp ──1:1── AgentRuntime ──1:1── sessionId        (create-app: `new AgentRuntime(sessionId, …)`)
 *        └──1:1── run service (built inside this app, the port is never lent out)
 *   CreateWorkflow handler submits carrying `parentSessionId = context.sessionId`
 *
 * And **only** the app's top-level runtime can obtain `dynamicWorkflowRunPort`: the dependency object of a subagent
 * child runtime (`new AgentRuntime(...)` in `core/src/runtime/methods/subagent.ts`) and the workflow actor runtime
 * (`script-workflow-child-runtime.ts`) both **exclude** that port (checked verbatim), so a child session can never
 * reach submit at all — its CreateWorkflow falls back onto the "port absent -> placeholder diagnostic" path.
 *
 * So `getRuntime()` is the right runtime. **But this invariant gets edited away by whoever comes next if it is not
 * written down**: the moment someone adds that port to a child runtime's dependencies, a run started from a child
 * session would project its events into the **parent** session's transcript — a bug that raises no error and only
 * makes events show up in the wrong conversation. So the identity is compared explicitly here, and on a mismatch
 * the event is **not appended** and a log line with guidance is recorded: better one projection too few than a
 * polluted transcript in someone else's session. (Actually supporting runs started from child sessions would need a
 * registry that finds a runtime by sessionId, and bootstrap has none — child runtimes live inside core. That is a
 * change with a design of its own.)
 */
export function createDynamicWorkflowRunProgressSink(
  deps: DynamicWorkflowRunProgressSinkDeps,
): (progress: DynamicWorkflowRunProgressPayload, routing?: { parentSessionId?: string }) => void {
  const warn = (message: string, runId: string, extra: Record<string, unknown> = {}): void => {
    deps.logger?.warn?.(message, {
      event: "dynamic_workflow.run_progress.append_failed",
      module: "bootstrap.app",
      runId,
      ...extra,
    });
  };

  return (progress, routing) => {
    const parentSessionId = routing?.parentSessionId;
    // Absence is legal (submit does not include parentSessionId): the port of this app can only be reached by this session.
    // So absence is equivalent to "this is the session". Only **explicit wait** is a wiring error.
    if (parentSessionId !== undefined && parentSessionId !== deps.sessionId) {
      warn("Dynamic workflow run progress dropped: parent session is not this app", progress.runId, {
        event: "dynamic_workflow.run_progress.session_mismatch",
        expectedSessionId: deps.sessionId,
        parentSessionId,
        reason: "run_parent_session_not_owned_by_this_app",
      });
      return;
    }

    // getRuntime() **throws an error synchronously** when the runtime has not yet been constructed; the closed runtime may also be in the append link
    // (Event library/persistence/sink fanout) throw up. Both must degenerate into "a no-op that keeps a log".
    let appended: Promise<void>;
    try {
      appended = deps.getRuntime().recordDynamicWorkflowRunProgress(progress);
    } catch (error) {
      warn("Dynamic workflow run progress append failed", progress.runId, {
        errorMessage: error instanceof Error ? error.message : String(error),
        reason: "runtime_unavailable",
      });
      return;
    }
    void appended.catch((error: unknown) => {
      warn("Dynamic workflow run progress append failed", progress.runId, {
        errorMessage: error instanceof Error ? error.message : String(error),
        reason: "append_rejected",
      });
    });
  };
}
