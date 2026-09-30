// ============================================================
// "Has a certain skill been loaded in this history?"
// ============================================================
// The skill gate of the workflow creation tool (tool/handlers/workflow-skill-gate.ts) asks this sentence. The criterion is deliberately taken from
// The runtime provider makes the history visible, rather than creating a separate session-level Set: the history is what the model remembers at the moment -
// compaction squeezes out the Skill call, and the skill text is no longer there, so the door should be closed again; resume / rewind
// When history is reconstructed, the answers are reconstructed along with it, without the need for a second set of hydration.

import type { RuntimeMessageEntry } from "./message-history.js";

const SKILL_TOOL_NAME = "Skill";

/**
 * Whether the history contains a **successfully completed** `Skill` call that loaded `skillName`.
 *
 * Success = the call issued by the assistant has a corresponding tool result entry and that entry is not an error. A call with no result at all (still running, rejected)
 * or a result with `isError` does not count. The skill name is recognized in both the current form `{ skill }` and the old form `{ name }`
 * (contracts' SkillInputSchema accepts both).
 */
export function sessionHasLoadedSkill(
  entries: readonly RuntimeMessageEntry[],
  skillName: string,
): boolean {
  const pendingCallIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "attachment") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (call.name === SKILL_TOOL_NAME && skillInputNames(call.input) === skillName) {
          pendingCallIds.add(call.id);
        }
      }
      continue;
    }
    if (
      message.role === "tool" &&
      message.toolCallId !== undefined &&
      pendingCallIds.has(message.toolCallId) &&
      message.isError !== true
    ) {
      return true;
    }
  }
  return false;
}

function skillInputNames(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const fields = input as { skill?: unknown; name?: unknown };
  if (typeof fields.skill === "string") return fields.skill;
  if (typeof fields.name === "string") return fields.name;
  return undefined;
}
