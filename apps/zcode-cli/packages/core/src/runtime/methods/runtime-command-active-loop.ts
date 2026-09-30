import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import type { MessageId } from "../deps.js";
import type { RuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  persistBackgroundTaskNotificationCommand,
  shouldSuppressTaskNotificationRuntimeCommand,
} from "./background-notifications.js";
import { persistSubagentMessageCommand } from "./subagent-messages.js";
import { isStaleBranchRuntimeCommand } from "./runtime-command-generation.js";
import { createRuntimeUserEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";

interface ActiveLoopRuntimeCommandDrainResult {
  backgroundSubagentResultConsumed: boolean;
  workflowResultConsumed: boolean;
  consumedCommandIds: RuntimeCommandId[];
  drained: number;
  messageIds: MessageId[];
  runtimeEntries: readonly RuntimeMessageEntry[];
}

export async function drainPendingRuntimeCommandsForActiveLoop(
  this: AgentRuntimeInternal,
): Promise<ActiveLoopRuntimeCommandDrainResult> {
  const commands = this.runtimeCommandQueue.getByMaxPriority("next");
  const consumedCommandIds: RuntimeCommandId[] = [];
  let backgroundSubagentResultConsumed = false;
  let workflowResultConsumed = false;
  const messageIds: MessageId[] = [];
  const runtimeEntries: RuntimeMessageEntry[] = [];

  for (const command of commands) {
    // The queued controlOnly wheel (the setting wheel of the GUI "Configuration") does not enter the activity turn, and the notifications queued after it cannot be
    // Let’s absorb it first: Those notifications are talking about the new run it just recorded. The model must first read “The settings have been adjusted and who is the new run”.
    // Read more about the progress of the new run. stop here,
    // The latter is left to the outer queue to run in order.
    if (command.mode === "control-only-turn") break;
    if (command.mode !== "task-notification" && command.mode !== "subagent-message") {
      continue;
    }
    const removed = this.runtimeCommandQueue.removeById(command.id);
    if (!removed) continue;
    if (isStaleBranchRuntimeCommand(this, removed)) continue;

    let messageId: MessageId;
    if (removed.mode === "task-notification") {
      if (shouldSuppressTaskNotificationRuntimeCommand.call(this, removed)) {
        continue;
      }
      messageId = await persistBackgroundTaskNotificationCommand.call(this, removed);
    } else if (removed.mode === "subagent-message") {
      messageId = await persistSubagentMessageCommand.call(this, removed, true);
    } else {
      continue;
    }

    consumedCommandIds.push(removed.id);
    // active-loop will not create a new TurnStarted; here the consumed facts are brought to the final state of the current turn, and only the source of the structured subagent is recognized to avoid Bash mixing in.
    if (
      removed.mode === "task-notification" &&
      removed.originMeta?.backgroundSource === "subagent"
    ) {
      backgroundSubagentResultConsumed = true;
    }
    if (
      removed.mode === "task-notification" &&
      removed.originMeta?.backgroundSource === "workflow"
    ) {
      workflowResultConsumed = true;
    }
    messageIds.push(messageId);
    runtimeEntries.push(
      createRuntimeUserEntry(
        removed.text,
        runtimeInputMetadata(
          removed.mode === "task-notification" ? "task_notification_steer" : "subagent_reply_steer",
        ),
      ),
    );
  }

  return {
    backgroundSubagentResultConsumed,
    workflowResultConsumed,
    consumedCommandIds,
    drained: consumedCommandIds.length,
    messageIds,
    runtimeEntries,
  };
}
