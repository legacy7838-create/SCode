export function resolveConversationSelectionTooltipEnabled({
  selectionActionsEnabled,
  partialShareActive,
}: {
  selectionActionsEnabled: boolean;
  partialShareActive: boolean;
}): boolean {
  // The local check mask only changes the visual level and does not turn off the global Selection monitoring.
  // So the underlying message can still evoke the cross-functional toolbar. Check mode must exclusive message selection interaction.
  return selectionActionsEnabled && !partialShareActive;
}

export function resolveConversationShareBackgroundScrollLocked({
  partialShareActive,
  stage = "selection",
  view,
}: {
  partialShareActive: boolean;
  stage?: "selection" | "configuration";
  view: "selection" | "timeline" | undefined;
}): boolean {
  // The selection panel only uses scrim to isolate the text pointer event, and the timeline is still
  // overflow-y-auto, background scrollbar and keyboard scrolling can still change scrollTop.
  return resolveConversationShareSelectionPanelVisible({ partialShareActive, stage, view });
}

export function resolveConversationShareSelectionPanelVisible({
  partialShareActive,
  stage = "selection",
  view,
}: {
  partialShareActive: boolean;
  stage?: "selection" | "configuration";
  view: "selection" | "timeline" | undefined;
}): boolean {
  // In the past, the visual mask was bound to the entire partial scope, and the mask remained after the panel was closed.
  // It can only be disguised as "positioning completed" by partially raising the target text. The mask must live and die with the visible state of the panel.
  return partialShareActive && stage === "selection" && view === "selection";
}
