import type { EditorInfo, OpenInEditorRemoteTarget, RemoteTarget } from "@zcode/shared";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";

const REMOTE_SSH_EDITOR_IDS = ["vscode", "vscode-insiders"];
const REMOTE_WSL_EDITOR_IDS = ["vscode", "vscode-insiders", "explorer"];

type WorkspaceEditorSelectionKind = "preferred" | "fallback" | "empty" | "explicit";

interface WorkspaceEditorSelectionState {
  availableEditors: EditorInfo[];
  selectedEditor: EditorInfo | null;
  selectionKind: Exclude<WorkspaceEditorSelectionKind, "explicit">;
}

export function resolveWorkspaceFileManagerEditor(
  availableEditors: EditorInfo[],
  remoteTarget?: RemoteTarget | OpenInEditorRemoteTarget,
): EditorInfo | null {
  // WSL's Explorer already has UNC mapping capabilities, "Open in Explorer" should be the same as
  // "Open with → Explorer" reuses the same editor entry; SSH still fails to close.
  if (remoteTarget?.kind !== "wsl") {
    return null;
  }
  return availableEditors.find((editor) => editor.id === "explorer") ?? null;
}

function filterEditorsByIdOrder(
  installedEditors: EditorInfo[],
  orderedIds: string[],
): EditorInfo[] {
  return orderedIds
    .map((id) => installedEditors.find((editor) => editor.id === id) ?? null)
    .filter((editor): editor is EditorInfo => editor !== null);
}

export function resolveWorkspaceEditorSelection({
  installedEditors,
  selectedEditorId,
  remoteTarget,
}: {
  installedEditors: EditorInfo[];
  selectedEditorId: string | null;
  remoteTarget?: RemoteTarget | OpenInEditorRemoteTarget;
}): WorkspaceEditorSelectionState {
  let availableEditors: EditorInfo[];

  if (remoteTarget?.kind === "ssh") {
    // The SSH workspace path only exists on the remote end, and local apps such as Finder/Explorer/Terminal
    // You cannot open `/root/...` directly, otherwise it will fall into a directory that does not exist on the local machine or is wrong.
    availableEditors = filterEditorsByIdOrder(installedEditors, REMOTE_SSH_EDITOR_IDS);
  } else if (remoteTarget?.kind === "wsl") {
    // WSL workspacePath is a Linux path, only VS Code Remote-WSL and Windows Explorer UNC
    // Boundaries are consumed correctly; other native editors cannot continue to bare `/home/...`.
    availableEditors = filterEditorsByIdOrder(installedEditors, REMOTE_WSL_EDITOR_IDS);
  } else {
    availableEditors = sortInstalledEditorsForOpenWith(installedEditors);
  }
  const preferredEditor =
    selectedEditorId === null
      ? null
      : (availableEditors.find((editor) => editor.id === selectedEditorId) ?? null);
  const fallbackEditor = availableEditors[0] ?? null;

  if (preferredEditor) {
    return {
      availableEditors,
      selectedEditor: preferredEditor,
      selectionKind: "preferred",
    };
  }

  return {
    availableEditors,
    selectedEditor: fallbackEditor,
    selectionKind: fallbackEditor ? "fallback" : "empty",
  };
}

export function shouldPersistWorkspaceEditorSelection(
  selectionKind: WorkspaceEditorSelectionKind,
): boolean {
  // The SSH workspace may automatically fallback to VS Code due to filtering of local apps.
  // This fallback is not an explicit user choice and cannot override the global editor preferences that the local workspace continues to use.
  return selectionKind === "explicit";
}
