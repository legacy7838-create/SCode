import { useEffect, useState } from "react";

export function useWorkspaceFileTreeRowDragState() {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    // Electron/browsers do not necessarily dispatch the dragend to the source line when dragging out of the window.
    // At the same time, monitor the global end signal to prevent the vertical line from being permanently hidden after an abnormal drag.
    const resetDragging = () => setIsDragging(false);
    window.addEventListener("dragend", resetDragging);
    window.addEventListener("drop", resetDragging);
    window.addEventListener("blur", resetDragging);
    return () => {
      window.removeEventListener("dragend", resetDragging);
      window.removeEventListener("drop", resetDragging);
      window.removeEventListener("blur", resetDragging);
    };
  }, [isDragging]);

  return { isDragging, setIsDragging };
}
