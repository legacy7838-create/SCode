import type { BackgroundBashOutputResult } from "@zcode/shared";
import type { AgentRuntimeInternal } from "../internal.js";

/** Execution records verify ownership against the sessionId captured at launch, so even an ancestor runtime cannot read another session's workId. */
export async function readBackgroundBashOutput(
  this: AgentRuntimeInternal,
  workId: string,
  sessionId = this.sessionId as string,
): Promise<BackgroundBashOutputResult> {
  if (!this.executionPort?.readBackgroundBashOutput) return { kind: "unsupported", workId };
  return this.executionPort.readBackgroundBashOutput(workId, sessionId);
}
