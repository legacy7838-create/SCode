import { LOCAL_TTFT_MAX_DETAILS, type LocalTtftFacts } from "@zcode/shared";

export function mergeLocalTtftFacts(
  prior: LocalTtftFacts | undefined,
  incoming: LocalTtftFacts,
): LocalTtftFacts | undefined {
  if (
    prior &&
    (prior.instanceId !== incoming.instanceId ||
      (prior.sessionId && incoming.sessionId && prior.sessionId !== incoming.sessionId) ||
      (prior.turnId && incoming.turnId && prior.turnId !== incoming.turnId))
  )
    return;
  const details = new Map(prior?.details?.map((detail) => [detail.id, detail]));
  for (const detail of incoming.details ?? []) {
    const previous = details.get(detail.id);
    if (previous?.end !== undefined) continue;
    if (details.has(detail.id) || details.size < LOCAL_TTFT_MAX_DETAILS)
      details.set(detail.id, detail);
  }
  // Cumulative facts only fill in the blanks, not allowing retransmitted early snapshots to erase known boundaries; the request ID is retained separately from the attempt.
  const merged: LocalTtftFacts = { ...incoming, ...prior, details: [...details.values()] };
  for (const key of [
    "sessionId",
    "turnId",
    "productTurnId",
    "queryId",
    "requestId",
    "logicalCallId",
    "cliVersion",
    "provider",
    "model",
    "admittedAt",
    "executionAt",
    "requestAt",
    "outputAt",
    "outputKind",
    "terminal",
    "excluded",
    "sendMode",
  ] as const) {
    if (merged[key] === undefined && incoming[key] !== undefined)
      Object.assign(merged, { [key]: incoming[key] });
  }
  if (
    incoming.sendMode === "guided" ||
    (incoming.sendMode === "queued" && merged.sendMode !== "guided")
  )
    merged.sendMode = incoming.sendMode;
  // Retrying the updateable model request identity; starting point only fills in the blanks, late to the old revision cannot change the winner back to the old attempt.
  if (
    incoming.revision !== undefined &&
    (prior?.revision === undefined || incoming.revision >= prior.revision)
  ) {
    merged.revision = incoming.revision;
    for (const key of ["requestId", "logicalCallId", "provider", "model"] as const)
      if (incoming[key] !== undefined) merged[key] = incoming[key];
  }
  merged.truncated ||= incoming.truncated;
  merged.clockInvalid ||= incoming.clockInvalid;
  return merged;
}
