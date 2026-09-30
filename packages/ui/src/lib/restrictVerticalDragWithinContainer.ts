import type { Modifier } from "@dnd-kit/core";

/* Vertical list drag constraints: lock the horizontal displacement and clamp the drag row to its container (activeNode.parentElement)
   within the rectangle. Standalone lib instead of inline in SortableWorkspaceSidebar: Idle-time intra-group dragging of sidebar groupings
   (spec off-peak) needs to reuse the same constraint, and SortableWorkspaceSidebar takes the entire
   The dependency chain of WorkspaceSidebarItem is not suitable for direct import by the displayed component, so it is raised as an independent lib. */
export const restrictVerticalDragWithinContainer: Modifier = ({
  transform,
  draggingNodeRect,
  activeNodeRect,
  containerNodeRect,
  windowRect,
}) => {
  const nodeRect = draggingNodeRect ?? activeNodeRect;
  const boundaryRect = containerNodeRect ?? windowRect;
  if (!nodeRect || !boundaryRect) {
    return {
      ...transform,
      x: 0,
    };
  }

  const minY = boundaryRect.top - nodeRect.top;
  const maxY = boundaryRect.bottom - nodeRect.bottom;
  const clampedY = Math.min(Math.max(transform.y, minY), maxY);

  return {
    ...transform,
    x: 0,
    y: clampedY,
  };
};
