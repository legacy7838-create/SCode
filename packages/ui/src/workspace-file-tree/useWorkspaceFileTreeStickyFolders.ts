import { useMemo } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/workspace-file-tree/constants.js";
import type { WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";
import type { WorkspaceFileTreeStickyFolderItem } from "@/workspace-file-tree/types.js";

function getWorkspaceFileTreeStickyFolders({
  rows,
  virtualItems,
  scrollOffset,
  enabled = true,
}: {
  rows: WorkspaceFileTreeRow[];
  virtualItems: VirtualItem[];
  scrollDirection: "forward" | "backward" | null;
  scrollOffset: number;
  enabled?: boolean;
}): WorkspaceFileTreeStickyFolderItem[] {
  if (!enabled) {
    return [];
  }
  if (virtualItems.length === 0 || rows.length === 0 || scrollOffset <= 0.5) {
    return [];
  }

  let stickyItems: WorkspaceFileTreeStickyFolderItem[] = [];
  for (let iteration = 0; iteration <= rows.length; iteration += 1) {
    const probeOffset =
      scrollOffset + stickyItems.length * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
    const probeIndex = Math.min(
      rows.length - 1,
      Math.floor(probeOffset / WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX),
    );
    const probeRow = rows[probeIndex];
    if (!probeRow) {
      return [];
    }

    const ancestorItems: WorkspaceFileTreeStickyFolderItem[] = [];
    const canStickProbeRow = probeRow.type === "directory" && probeRow.expanded;
    let stickyDepth = canStickProbeRow ? probeRow.depth : probeRow.depth - 1;
    for (
      let index = canStickProbeRow ? probeIndex : probeIndex - 1;
      index >= 0 && stickyDepth >= 0;
      index -= 1
    ) {
      const row = rows[index];
      if (!row || row.type !== "directory" || !row.expanded) {
        continue;
      }
      if (row.depth === stickyDepth) {
        ancestorItems.push({ row, index });
        stickyDepth = row.depth - 1;
      }
    }
    ancestorItems.reverse();

    const nextStickyItems = ancestorItems.filter((item, stickyIndex) => {
      const rowStart = item.index * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
      const stickyBoundary = scrollOffset + stickyIndex * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
      return rowStart <= stickyBoundary + 0.5;
    });
    if (nextStickyItems.length === stickyItems.length) {
      return nextStickyItems;
    }
    stickyItems = nextStickyItems;
  }
  return stickyItems;
}

export function useWorkspaceFileTreeStickyFolders({
  rows,
  virtualItems,
  scrollDirection,
  scrollOffset,
  enabled,
}: {
  rows: WorkspaceFileTreeRow[];
  virtualItems: VirtualItem[];
  scrollDirection: "forward" | "backward" | null;
  scrollOffset: number;
  enabled: boolean;
}) {
  const stickyFolderItems = useMemo<WorkspaceFileTreeStickyFolderItem[]>(() => {
    // Each layer of sticky lines will push the trigger line of the next layer down 28px; if all levels
    // They are only compared with scrollTop, and subdirectories will be moved to the top later. By probing the lines below the sticky stack,
    // Let the calculated trigger line use the same cumulative offset as CSS top.
    return getWorkspaceFileTreeStickyFolders({
      rows,
      virtualItems,
      scrollDirection,
      scrollOffset,
      enabled,
    });
  }, [enabled, rows, scrollDirection, scrollOffset, virtualItems]);

  // The ceiling row was previously moved out of the virtual list and rewritten scrollTop, when the mouse drags the scroll bar
  // Will compete with the browser's native drag position. Now the original line is retained, CSS sticky is only responsible for the visual overlay.
  return stickyFolderItems;
}
