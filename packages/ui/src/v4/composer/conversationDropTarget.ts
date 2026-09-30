import type { DragEventHandler } from "react";

/**
 * The file drop interface that ConversationComposer exposes to the outer conversation surface.
 *
 * The controller only routes to the existing composer inside the renderer; it does not create a
 * second upload state machine, and it does not change the transport boundary of desktop continuous
 * / web-remote-replayable.
 */
export interface ConversationDropTargetController {
  active: boolean;
  kind: "attachment" | "workspace" | null;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
}
