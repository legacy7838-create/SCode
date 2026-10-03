/**
 * PHASE 2 oracle: capture the subagent tool-event mirror from the live TypeScript
 * implementation, so the Rust port can be proven identical.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 2).
 *
 * The mirror is what puts a child's tool activity into the PARENT session's timeline.
 * If it drifts, a parent's Agent call stops showing progress and — worse — a permission
 * request from the child stops being answerable, so this is correctness, not cosmetics.
 *
 * Run: pnpm exec tsx scripts/capture-subagent-mirror-golden.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";

import { mirrorSubagentToolEvent } from "../apps/zcode-cli/packages/core/src/subagent/tool-event-mirror.ts";

const OUT = new URL(
  "../apps/zcode-cli/packages/core/testdata/agent-profiles",
  import.meta.url,
).pathname;

const AGENT_ID = "agent_abc";
const CHILD_SESSION = "sess_subagent_agent_abc";
const PARENT_SESSION = "sess_parent";

function context(overrides: Record<string, unknown> = {}) {
  return {
    agentId: AGENT_ID,
    agentType: "general-purpose",
    childSessionId: CHILD_SESSION,
    parentSessionId: PARENT_SESSION,
    parentToolCallId: "call_parent_1",
    parentTurnId: "turn_parent_1",
    description: "Review the diff",
    background: false,
    ...overrides,
  } as Parameters<typeof mirrorSubagentToolEvent>[1];
}

/** `createSessionEvent(type, sessionId, payload, {traceId, turnId})` shape. */
function event(type: string, payload: Record<string, unknown>, turnId = "turn_child_1") {
  return {
    id: "evt_child_1",
    sessionId: CHILD_SESSION,
    turnId,
    type,
    payload,
    traceId: "trace_abc",
  } as unknown as Parameters<typeof mirrorSubagentToolEvent>[0];
}

const CASES: { name: string; run: () => unknown }[] = [
  {
    name: "tool_scheduled",
    run: () =>
      mirrorSubagentToolEvent(
        event("tool_call_scheduled", { toolCallId: "child_tc_1", toolName: "Bash" }),
        context(),
      ),
  },
  {
    name: "tool_started_without_name_learns_from_cache",
    run: () => {
      const cache = new Map<string, string>();
      mirrorSubagentToolEvent(
        event("tool_call_scheduled", { toolCallId: "child_tc_1", toolName: "Read" }),
        context({ toolNameByChildToolCallId: cache }),
      );
      return mirrorSubagentToolEvent(
        event("tool_call_started", { toolCallId: "child_tc_1" }),
        context({ toolNameByChildToolCallId: cache }),
      );
    },
  },
  {
    name: "tool_result",
    run: () =>
      mirrorSubagentToolEvent(
        event("tool_call_result", {
          toolCallId: "child_tc_2",
          toolName: "Grep",
          ok: true,
          output: "3 matches",
        }),
        context(),
      ),
  },
  {
    name: "tool_error_background",
    run: () =>
      mirrorSubagentToolEvent(
        event("tool_call_error", { toolCallId: "child_tc_3", toolName: "Bash", error: "boom" }),
        context({ background: true }),
      ),
  },
  {
    name: "schedule_with_dependencies_and_groups",
    run: () =>
      mirrorSubagentToolEvent(
        event("tool_call_scheduled", {
          toolCallId: "child_tc_4",
          toolName: "Bash",
          dependencies: ["child_tc_1", "child_tc_2", 7],
          schedule: {
            executionOrder: ["child_tc_1", "child_tc_2", 9],
            parallelGroups: [["child_tc_3", "child_tc_4"], ["child_tc_5"]],
            note: "kept",
          },
        }),
        context(),
      ),
  },
  {
    name: "schedule_empty_object_ignored",
    run: () =>
      mirrorSubagentToolEvent(
        event("tool_call_scheduled", { toolCallId: "child_tc_5", toolName: "Read", schedule: {} }),
        context(),
      ),
  },
  {
    name: "permission_requested_with_origin",
    run: () =>
      mirrorSubagentToolEvent(
        event("permission_requested", { toolCallId: "child_tc_6", toolName: "Bash" }),
        context(),
      ),
  },
  {
    name: "permission_resolved",
    run: () =>
      mirrorSubagentToolEvent(
        event("permission_resolved", { toolCallId: "child_tc_6", decision: "allow" }),
        context(),
      ),
  },
  {
    name: "permission_denied_background",
    run: () =>
      mirrorSubagentToolEvent(
        event("permission_denied", { toolCallId: "child_tc_7", reason: "policy" }),
        context({ background: true }),
      ),
  },
  {
    name: "unmirrored_type_returns_nothing",
    run: () =>
      mirrorSubagentToolEvent(
        event("assistant_message", { toolCallId: "child_tc_8", text: "hi" }),
        context(),
      ),
  },
  {
    name: "missing_tool_call_id_returns_nothing",
    run: () => mirrorSubagentToolEvent(event("tool_call_started", { toolName: "Bash" }), context()),
  },
  {
    name: "non_string_tool_call_id_returns_nothing",
    run: () => mirrorSubagentToolEvent(event("tool_call_started", { toolCallId: 42 }), context()),
  },
  {
    name: "origin_without_parent_tool_use_id",
    run: () =>
      mirrorSubagentToolEvent(
        event("permission_requested", { toolCallId: "child_tc_9" }),
        context({ parentToolCallId: undefined }),
      ),
  },
];

const results: Record<string, unknown> = {};
for (const testCase of CASES) {
  results[testCase.name] = testCase.run() ?? null;
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/subagent-mirror-golden.json`, JSON.stringify(results, null, 2) + "\n");
const mirrored = Object.values(results).filter((value) => value !== null).length;
console.log(`captured ${CASES.length} mirror cases (${mirrored} mirrored, ${CASES.length - mirrored} dropped)`);
