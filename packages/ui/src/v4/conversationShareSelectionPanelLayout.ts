/**
 * The geometric constraints of the share selection panel; the panel content itself is still adapted
 * by CSS.
 */
const CONVERSATION_SHARE_SELECTION_PANEL_EDGE_INSET_PX = 24;
const CONVERSATION_SHARE_SELECTION_PANEL_DOCK_GAP_PX = 16;
/**
 * Two candidate rows (48px each, 8px apart) plus 16px of top and bottom panel padding — below this
 * height the panel is no longer usable.
 */
const CONVERSATION_SHARE_SELECTION_PANEL_MIN_HEIGHT_PX = 120;
export const CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY =
  "--conversation-share-selection-panel-max-height";
export const CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY =
  "--conversation-share-selection-panel-center-y";

interface ConversationShareSelectionPanelLayoutInput {
  /** The height of the conversation content container, excluding the WorkspaceHeader. */
  containerHeightPx: number;
  /**
   * The top edge of the bottom composer/share dock, in coordinates relative to the conversation
   * content container.
   */
  dockStartPx: number;
}

interface ConversationShareSelectionPanelLayout {
  centerYPx: number;
  maxHeightPx: number;
  topPx: number;
  bottomPx: number;
}

function normalizeSize(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Computes the panel's maximum visible height and its vertical anchor.
 *
 * When the panel holds little content the actual height is decided by measuring the content; this
 * only supplies a max-height, so that a natural height exceeding the bottom dock does not cover the
 * input area. The top baseline is pinned inside the margin safe area, and on a bottom collision
 * only the panel's visible height is compressed, with the list still scrolling inside the
 * ScrollArea.
 *
 * `min(height available in the container, height above the dock)` alone is not enough: on a short
 * viewport or a tall dock the latter approaches 0 and the panel is squeezed into an unusable
 * zero-height sliver. A minimum height is therefore kept now: the top safe margin is reclaimed
 * first, and only if that is still not enough is it allowed to encroach on the dock's spacing,
 * never exceeding the container itself.
 */
function resolveConversationShareSelectionPanelLayout({
  containerHeightPx,
  dockStartPx,
}: ConversationShareSelectionPanelLayoutInput): ConversationShareSelectionPanelLayout {
  const containerHeight = normalizeSize(containerHeightPx);
  const dockStart = Math.min(containerHeight, normalizeSize(dockStartPx));
  const unconstrainedMaxHeight = Math.max(
    0,
    containerHeight - CONVERSATION_SHARE_SELECTION_PANEL_EDGE_INSET_PX * 2,
  );
  const minHeight = Math.min(
    unconstrainedMaxHeight,
    CONVERSATION_SHARE_SELECTION_PANEL_MIN_HEIGHT_PX,
  );
  const top = Math.max(
    0,
    Math.min(
      CONVERSATION_SHARE_SELECTION_PANEL_EDGE_INSET_PX,
      dockStart - CONVERSATION_SHARE_SELECTION_PANEL_DOCK_GAP_PX - minHeight,
    ),
  );
  const availableHeight = Math.max(
    0,
    dockStart - CONVERSATION_SHARE_SELECTION_PANEL_DOCK_GAP_PX - top,
  );
  const maxHeight = Math.max(minHeight, Math.min(unconstrainedMaxHeight, availableHeight));

  return {
    centerYPx: top + maxHeight / 2,
    maxHeightPx: maxHeight,
    topPx: top,
    bottomPx: top + maxHeight,
  };
}

/**
 * Writes the layout result into the shared parent container, so that the panel and the Timeline use
 * one and the same coordinate system.
 */
export function syncConversationShareSelectionPanelLayout(
  container: HTMLElement,
  dock: HTMLElement,
): ConversationShareSelectionPanelLayout {
  const containerRect = container.getBoundingClientRect();
  const dockRect = dock.getBoundingClientRect();
  const layout = resolveConversationShareSelectionPanelLayout({
    containerHeightPx: containerRect.height,
    dockStartPx: dockRect.top - containerRect.top,
  });
  const maxHeight = `${layout.maxHeightPx}px`;
  const centerY = `${layout.centerYPx}px`;

  if (
    container.style.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY) !==
    maxHeight
  ) {
    container.style.setProperty(CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY, maxHeight);
  }
  if (
    container.style.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY) !==
    centerY
  ) {
    container.style.setProperty(CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY, centerY);
  }

  return layout;
}
