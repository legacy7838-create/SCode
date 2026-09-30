import type {
  MessageAnchorOrigin,
  MessageProjectionAnchor,
  SyntheticUserMessageSource,
  TraceContext,
} from "../deps.js";

// ── v4 transcript anchor (list)──
// additive JSON: old data has no anchor, and is tolerant of downgrades on the reading side; the value of turnId is ready-made (traceContext).
// sourceCommandId is written with the command execution context after wiring in the v4 command inbox.
export function buildProjectionAnchor(
  traceContext: TraceContext,
  origin?: MessageAnchorOrigin,
  sourceCommandId?: string,
): MessageProjectionAnchor | undefined {
  if (traceContext.turnId === undefined && origin === undefined && sourceCommandId === undefined) {
    return undefined;
  }
  return {
    ...(traceContext.turnId ? { turnId: traceContext.turnId } : {}),
    ...(origin ? { origin } : {}),
    ...(sourceCommandId ? { sourceCommandId } : {}),
  };
}

// Old SyntheticUserMessageSource → v4 read-only mapping of userInput.origin vocabulary.
export function mapSyntheticSourceToAnchorOrigin(
  source: SyntheticUserMessageSource,
): MessageAnchorOrigin {
  switch (source) {
    case "background_task":
    case "subagent":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    default:
      return "synthetic";
  }
}
