import type { InputRouting } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationComposerSendOptions } from "@/v4/ConversationComposer.js";

interface PromptScrollFocusPolicyInput {
  draftMode: boolean;
  inputRoutingMode: InputRouting["mode"] | null;
  heldQueueDisposition?: ConversationComposerSendOptions["heldQueueDisposition"];
}

/**
 * A new prompt focuses the bottom of the timeline only when it truly takes the send-now path. The
 * reason: enqueue expresses future intent, and the user may be reading the text above at that
 * moment, so queueing must not steal the reading position; both explicit dispositions of a held
 * choice start immediately with startNow, so they behave like an ordinary direct send.
 */
export function shouldFocusTimelineAfterComposerSend(input: PromptScrollFocusPolicyInput): boolean {
  if (input.draftMode) return true;
  if (input.heldQueueDisposition) return true;
  return input.inputRoutingMode === "startNow";
}
