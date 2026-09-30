import { useEffect, useRef, useState } from "react";
import {
  hasWorkspaceFileDragPayload,
  isWorkspaceFileDragStateEvent,
  WORKSPACE_FILE_DRAG_STATE_EVENT,
} from "@/lib/workspaceFileDrag.js";

function hasExternalFileDrag(dataTransfer: DataTransfer): boolean {
  return (
    Array.from(dataTransfer.types).includes("Files") ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  );
}

export function usePromptEditorDragState({
  enableWorkspaceFileDrop,
  enableExternalFileDrop,
}: {
  enableWorkspaceFileDrop: boolean;
  enableExternalFileDrop: boolean;
}) {
  const [internalDragging, setInternalDragging] = useState(false);
  const [workspaceFileDragging, setWorkspaceFileDragging] = useState(false);
  const [externalFileDragging, setExternalFileDragging] = useState(false);
  const resetDragFeedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if ((!enableWorkspaceFileDrop && !enableExternalFileDrop) || typeof window === "undefined") {
      setWorkspaceFileDragging(false);
      setExternalFileDragging(false);
      return;
    }

    const clearResetDragFeedbackTimer = () => {
      if (resetDragFeedbackTimerRef.current === null) {
        return;
      }

      window.clearTimeout(resetDragFeedbackTimerRef.current);
      resetDragFeedbackTimerRef.current = null;
    };
    const resetDragFeedback = () => {
      clearResetDragFeedbackTimer();
      setWorkspaceFileDragging(false);
      setExternalFileDragging(false);
      setInternalDragging(false);
    };
    const scheduleDragFeedbackReset = () => {
      clearResetDragFeedbackTimer();
      // When canceling OS file drag or dragging the file tree out of the window, Electron/browser may not dispatch drop/dragend.
      // dragover will continue to be triggered while the dragging is still within the window; once the heartbeat stops, the highlight of the input box will be automatically canceled to avoid visual feedback being stuck.
      resetDragFeedbackTimerRef.current = window.setTimeout(resetDragFeedback, 300);
    };
    const handleWorkspaceFileDragState = (event: Event) => {
      if (isWorkspaceFileDragStateEvent(event)) {
        setWorkspaceFileDragging(event.detail.dragging);
        if (event.detail.dragging) {
          scheduleDragFeedbackReset();
        } else {
          resetDragFeedback();
        }
      }
    };
    const handleGlobalDragOver = (event: DragEvent) => {
      if (!event.dataTransfer) {
        return;
      }
      // Some drag paths do not trigger the dragover of the target input box first.
      // After monitoring window-level dragover, as long as the drag data can be recognized, all droppable input boxes will be displayed in advance.
      if (enableWorkspaceFileDrop && hasWorkspaceFileDragPayload(event.dataTransfer)) {
        setWorkspaceFileDragging(true);
        scheduleDragFeedbackReset();
      } else if (enableExternalFileDrop && hasExternalFileDrag(event.dataTransfer)) {
        setExternalFileDragging(true);
        scheduleDragFeedbackReset();
      }
    };
    const handleDocumentDragLeave = (event: DragEvent) => {
      if (event.relatedTarget !== null) {
        return;
      }

      resetDragFeedback();
    };

    window.addEventListener(WORKSPACE_FILE_DRAG_STATE_EVENT, handleWorkspaceFileDragState);
    window.addEventListener("dragover", handleGlobalDragOver);
    window.addEventListener("dragend", resetDragFeedback);
    window.addEventListener("drop", resetDragFeedback);
    window.addEventListener("blur", resetDragFeedback);
    if (typeof document !== "undefined") {
      document.addEventListener("dragleave", handleDocumentDragLeave);
    }
    return () => {
      clearResetDragFeedbackTimer();
      window.removeEventListener(WORKSPACE_FILE_DRAG_STATE_EVENT, handleWorkspaceFileDragState);
      window.removeEventListener("dragover", handleGlobalDragOver);
      window.removeEventListener("dragend", resetDragFeedback);
      window.removeEventListener("drop", resetDragFeedback);
      window.removeEventListener("blur", resetDragFeedback);
      if (typeof document !== "undefined") {
        document.removeEventListener("dragleave", handleDocumentDragLeave);
      }
    };
  }, [enableExternalFileDrop, enableWorkspaceFileDrop]);

  return {
    externalFileDragging,
    internalDragging,
    setExternalFileDragging,
    setInternalDragging,
    setWorkspaceFileDragging,
    workspaceFileDragging,
  };
}
