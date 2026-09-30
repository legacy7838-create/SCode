import type { MutableRefObject } from "react";
// Returns the original handle type after LexicalChatInput shell recovery (transitional ComposerInputHandle minimal surface retirement).
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import {
  createWorkspaceFileComposerMention,
  type WorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";

export function appendWorkspaceFileMentionToComposer(params: {
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  currentMarkdown: string;
  payload: WorkspaceFileDragPayload;
  workspacePath: string;
  workspaceIdentity?: string;
  onTextChange: (text: string) => void;
}) {
  const mention = createWorkspaceFileComposerMention(
    params.payload,
    params.workspacePath,
    params.workspaceIdentity,
  );
  const separator =
    params.currentMarkdown.length > 0 && !/\s$/.test(params.currentMarkdown) ? " " : "";
  const nextText = `${params.currentMarkdown}${separator}${mention.markdown} `;

  params.onTextChange(nextText);
  params.inputApiRef.current?.appendFileMention(
    params.payload.name,
    mention.value,
    mention.markdown,
    mention.data,
  );
  params.inputApiRef.current?.focus();

  return nextText;
}
