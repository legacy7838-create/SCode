/**
 * ChatView was removed in the vertical cut; these are the minimal types still referenced by the
 * shell / command-center.
 */
export interface ChatSearchResultHighlightRequest {
  requestId: number;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  query: string;
  snippet?: string;
  snippetIndex?: number;
}

export interface ConversationFindMatchState {
  matchCount: number;
  activeIndex?: number;
}

export type ChatViewSummaryPanelVariant = "panel" | "mini";
