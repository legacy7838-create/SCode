import type { AppSettings } from "@zcode/shared";
import type { InputRouting, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

export function resolveAppFollowupMode(
  settings: AppSettings | null | undefined,
): SessionConfigState["followupMode"] | null {
  if (!settings) return null;
  return settings.zcodeInteractionBehavior === "guide" ? "guide" : "queue";
}

export function resolveOppositeFollowupDelivery(
  mode: SessionConfigState["followupMode"],
): "startNow" | "queue" {
  // The modifier key sending in queue mode was once interpreted as a guide; "send immediately" is actually the existing preemption semantics of the queue.
  return mode === "guide" ? "queue" : "startNow";
}

export function shouldEnableModifiedEnterSubmit({
  inputRoutingMode,
}: {
  inputRoutingMode: InputRouting["mode"];
}): boolean {
  return inputRoutingMode !== "reject";
}

export function shouldReverseFollowupDeliveryForPointer({
  enabled,
  metaKey = false,
  ctrlKey = false,
  isApplePlatform,
}: {
  enabled: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isApplePlatform?: boolean;
}): boolean {
  return (
    enabled &&
    (isApplePlatform === undefined
      ? metaKey || ctrlKey
      : isPrimaryFollowupModifierPressed({ isApplePlatform, metaKey, ctrlKey }))
  );
}

export function isPrimaryFollowupModifierPressed({
  isApplePlatform,
  metaKey = false,
  ctrlKey = false,
}: {
  isApplePlatform: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  return isApplePlatform ? metaKey : ctrlKey;
}

interface FollowupModifierTooltip {
  delivery: "startNow" | "queue";
  shortcut: string;
  titleId: "chat.followup.sendNow" | "chat.followup.addToQueue";
}

export function resolveFollowupModifierTooltip({
  enabled,
  canSend,
  modifierPressed,
  followupMode,
  isApplePlatform,
}: {
  enabled: boolean;
  canSend: boolean;
  modifierPressed: boolean;
  followupMode: SessionConfigState["followupMode"] | undefined;
  isApplePlatform: boolean;
}): FollowupModifierTooltip | null {
  if (!enabled || !canSend || !modifierPressed || !followupMode) return null;
  const delivery = resolveOppositeFollowupDelivery(followupMode);
  return {
    delivery,
    shortcut: isApplePlatform ? "⌘ + Enter" : "Ctrl + Enter",
    titleId: delivery === "startNow" ? "chat.followup.sendNow" : "chat.followup.addToQueue",
  };
}
