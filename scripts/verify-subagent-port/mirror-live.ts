/** Verification section: mirror-live. See docs/specs/subagent-rust-port.md. */
import { createSubagentEventMirror } from "../../packages/rust/src/subagentProfile.ts";
import { check } from "./harness.js";

export function run(): void {
{
// Phase 2 live proof: the tool-event mirror now runs in Rust.
const CHILD = "sess_subagent_agent_abc";
function evt(type: string, payload: Record<string, unknown>) {
  return { id: "e1", sessionId: CHILD, turnId: "turn_child_1", type, payload, traceId: "trace_abc" };
}
const ctx = {
  agentId: "agent_abc", agentType: "general-purpose", childSessionId: CHILD,
  parentSessionId: "sess_parent", parentToolCallId: "call_parent_1",
  parentTurnId: "turn_parent_1", description: "Review the diff", background: false,
};
// 1. scheduled teaches the cache; started reuses the name
const mirror = createSubagentEventMirror(ctx);
const scheduled = mirror.mirror(evt("tool_call_scheduled", { toolCallId: "tc_1", toolName: "Bash" })) as any;
check("scheduled mirrored", scheduled?.payload?.toolCallId === "tool_subagent_agent_abc_tc_1");
check("scheduled routes to parent session", scheduled?.sessionId === "sess_parent" && scheduled?.turnId === "turn_parent_1");
check("scheduled carries source", scheduled?.payload?.source === "subagent");
const started = mirror.mirror(evt("tool_call_started", { toolCallId: "tc_1" })) as any;
check("started reuses learned toolName", started?.payload?.toolName === "Bash");
// 2. permission request carries an origin the parent can act on
const perm = mirror.mirror(evt("permission_requested", { toolCallId: "tc_2", toolName: "Edit" })) as any;
check("permission mirrored", perm?.type === "permission_requested");
check("origin kind is subagent", perm?.payload?.origin?.kind === "subagent");
check("origin names the agent", perm?.payload?.origin?.agentId === "agent_abc");
check("origin keeps child turn", perm?.payload?.origin?.childTurnId === "turn_child_1");
// 3. unmirrored types are dropped, not leaked
check("assistant message dropped", mirror.mirror(evt("assistant_message", { toolCallId: "tc_3" })) === undefined);
check("missing toolCallId dropped", mirror.mirror(evt("tool_call_started", { toolName: "Bash" })) === undefined);
// 4. two mirrors do not share the cache
const other = createSubagentEventMirror({ ...ctx, agentId: "agent_zzz" });
const otherStarted = other.mirror(evt("tool_call_started", { toolCallId: "tc_1" })) as any;
check("cache is per child run", otherStarted?.payload?.toolName === undefined);
// 5. background flag
const bg = createSubagentEventMirror({ ...ctx, background: true });
const bgEvent = bg.mirror(evt("tool_call_error", { toolCallId: "tc_9", error: "x" })) as any;
check("background flag set", bgEvent?.payload?.background === true);
}
}
