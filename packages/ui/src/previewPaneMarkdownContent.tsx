import { useMemo, useRef } from "react";
import { MarkdownSelectionTooltip } from "@/v4/MarkdownSelectionTooltip.js";
import type { MarkdownSelectionTarget } from "@/lib/conversationSelectionReference.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { Theme } from "@/useTheme.js";

interface MarkdownPreviewContentProps {
  content: string;
  sourceKey?: string;
  sourceTitle?: string;
  sourcePath?: string;
  selectionTarget?: MarkdownSelectionTarget;
  workspacePath?: string;
  /** Application theme (store coupling stripping): transparently passed to markdown rendering, default is "system". */
  theme?: Theme;
  /** Code preview settings (store coupling stripping): Transparent to markdown rendering, the reference needs to be kept stable. */
  codePreviewSettings?: CodePreviewSettings;
  onOpenBrowserUrl?: (url: string) => void;
}

export function MarkdownPreviewContent({
  content,
  sourceKey,
  sourceTitle,
  sourcePath,
  selectionTarget,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenBrowserUrl,
}: MarkdownPreviewContentProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectionScope = useMemo(
    () => ({}),
    [content, sourceKey, sourcePath, selectionTarget?.workspaceKey, selectionTarget?.sessionId],
  );
  return (
    <div
      ref={rootRef}
      data-markdown-preview="true"
      className="w-full h-full bg-background overflow-auto"
    >
      {selectionTarget && sourceKey ? (
        <MarkdownSelectionTooltip
          scopeKey={selectionScope}
          rootRef={rootRef}
          sourceKey={sourceKey}
          sourceTitle={sourceTitle ?? sourceKey}
          sourcePath={sourcePath}
          target={selectionTarget}
        />
      ) : null}
      <div className="min-h-full bg-background p-4">
        <MessageResponse
          className="min-w-0 break-words"
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenExternalUrl={onOpenBrowserUrl}
        >
          {content}
        </MessageResponse>
      </div>
    </div>
  );
}
