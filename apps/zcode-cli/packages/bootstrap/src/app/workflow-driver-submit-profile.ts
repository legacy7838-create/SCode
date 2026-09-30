// ============================================================
// Runtime guards for submit profile
// ============================================================
// Independent file: workflow-driver.ts has already exceeded max-lines, and this read-only driver's deps/sink/session state,
// Has nothing to do with the rest of the state machine.
//
// The static profile is a derivation of the site map may-set; a typed ask falls on a session that does not match it, which may only be due to insufficient analysis.
// To be precise - it's not the script's fault, nor should run silently error:
//   - `mono` but with a different schema: change this session's submit_result back to a generic declaration and let the runtime recalculate the tool surface,
//     Thereafter the session will be run as generic (the endnote will contain the entire schema). The cost is that the cache prefix is ​​invalidated once, and the correctness is not affected.
//   - `untyped`: This runtime does not have a submit port at all (the factory does not inject it according to the profile), and there is no tool to replace it——
//     Let **this ask** fail with DriverError and tell which site it is, instead of letting it exhaust nudge and then
//     ResultNotSubmitted failed, disguising analysis problems as model problems.

import { submitResultToolEntry } from "@zcode/core";
import {
  GENERIC_SUBMIT_PROFILE,
  canonicalJson,
  refToString,
  WorkflowError,
  type AskMessage,
  type InstanceRef,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/** The log event name used when a static profile does not match the ask. */
const SUBMIT_PROFILE_MISMATCH_EVENT = "dynamic_workflow.submit_profile.mismatch";

/**
 * Makes the shape of the session's submit_result match this typed ask. Returning false means the ask has already failed and the caller must not dispatch
 * a turn. A generic session and a mono session with the same schema pass through untouched.
 */
export function ensureSubmitProfileFits(
  deps: AgentRuntimeWorkflowDriverDeps,
  sink: WorkflowReportSink,
  state: SessionState,
  instance: InstanceRef,
  message: AskMessage,
): boolean {
  const profile = state.submitProfile;
  if (profile.kind === "generic") return true;
  if (profile.kind === "mono" && canonicalJson(profile.schema) === canonicalJson(message.schema)) {
    return true;
  }
  if (profile.kind === "untyped") {
    sink.askFailed(
      instance,
      new WorkflowError(
        "DriverError",
        `Typed ask ${refToString(instance)} reached subagent session ${state.sessionId} whose static ` +
          `submit profile is "untyped" (no submit_result registered): the ask→actor analysis missed this ask.`,
      ),
    );
    return false;
  }
  deps.logger?.warn?.(
    "Dynamic workflow submit profile mismatch: falling back to the generic submit_result",
    {
      event: SUBMIT_PROFILE_MISMATCH_EVENT,
      module: "bootstrap.app",
      instance: refToString(instance),
      runId: deps.runId ?? "run",
      sessionId: state.sessionId,
    },
  );
  // Same registry, same name: register overrides the typed entry; silently, because overwriting is exactly the intention. The cache must be invalidated,
  // Otherwise getTools will continue to send the old typed declaration to the model.
  state.runtime.getToolRegistry().register(submitResultToolEntry, { silentDuplicateWarning: true });
  state.runtime.invalidateToolCache();
  state.submitProfile = GENERIC_SUBMIT_PROFILE;
  return true;
}
