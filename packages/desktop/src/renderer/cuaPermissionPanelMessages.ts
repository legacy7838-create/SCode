import type { CuaPermissionKind } from "@zcode/shared";

interface CuaPermissionPanelMessages {
  documentTitle: string;
  dragTitle: string;
  hintPrefix: string;
  permissionLabel: string;
  hintSuffix: string;
  completion: string;
}

const PERMISSION_LABELS = {
  accessibility: "Accessibility",
  screen_recording: "Screen Recording",
} satisfies Record<CuaPermissionKind, string>;

const MESSAGES = {
  documentTitle: "ZCode Computer Use Permissions",
  dragTitle: "Drag me to the permission list above",
  hintPrefix: "Drag the icon on the left into the ",
  hintSuffix: " list above",
  completion: "Release to grant access—no need to toggle the switch",
} satisfies Omit<CuaPermissionPanelMessages, "permissionLabel">;

export function resolveCuaPermissionPanelMessages(
  permission: CuaPermissionKind,
): CuaPermissionPanelMessages {
  return {
    documentTitle: MESSAGES.documentTitle,
    dragTitle: MESSAGES.dragTitle,
    hintPrefix: MESSAGES.hintPrefix,
    permissionLabel: PERMISSION_LABELS[permission],
    hintSuffix: MESSAGES.hintSuffix,
    completion: MESSAGES.completion,
  };
}
