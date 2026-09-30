import { useEffect, useState, type ReactNode } from "react";
import type { FileMediaPreview } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { MessageResponse, type MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { ToolInput, ToolOutput } from "@/components/ai-elements/tool.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  CodeViewerSource,
  ImageCodeViewerSource,
  TextCodeViewerSource,
} from "@/lib/codeViewer.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ToolDisplayModel, ToolInlinePreview } from "@/lib/toolDisplay.js";
import type { Theme } from "@/useTheme.js";

export function ToolCallBody({
  childToolList,
  displayModel,
  inlinePreviewOverride,
  toolCall,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  childToolList: ReactNode;
  displayModel: ToolDisplayModel;
  inlinePreviewOverride?: ToolInlinePreview;
  toolCall: TaskChatToolCallTreeNode["toolCall"];
  workspacePath: string;
  /** Application theme (store coupling stripping): transparently passed to markdown/code block rendering, default is "system". */
  theme?: Theme;
  /** Code preview settings (store coupling stripping): Transparent to markdown rendering, the reference needs to be kept stable. */
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  const inlinePreview = inlinePreviewOverride ?? displayModel.inlinePreview;

  return (
    <>
      {childToolList ?? (
        <>
          {inlinePreview.type === "text" ? (
            <InlineCodeContent
              preview={inlinePreview.source}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
            />
          ) : null}
          {inlinePreview.type === "image" ? (
            <InlineImageContent preview={inlinePreview.source} />
          ) : null}
          {displayModel.planResult ? (
            <InlinePlanResult
              plan={displayModel.planResult.plan}
              planFilePath={displayModel.planResult.planFilePath}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
            />
          ) : null}
          {displayModel.showInput && toolCall.input !== undefined ? (
            <ToolInput input={toolCall.input} />
          ) : null}
          {displayModel.showOutput ? (
            <ToolOutput errorText={toolCall.error} output={toolCall.output} />
          ) : null}
          {displayModel.showKind ? (
            <p className="text-ui-base text-muted-foreground">{toolCall.kind}</p>
          ) : null}
        </>
      )}
    </>
  );
}

function InlineCodeContent({
  preview,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  preview: TextCodeViewerSource;
  workspacePath: string;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  if (preview.language === "markdown") {
    return (
      <div className="max-h-60 overflow-auto rounded-xl border border-border bg-muted/15 px-3 py-3">
        <MessageResponse
          className="min-w-0 break-words"
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          // The markdown file link in the tool output only got onOpenCodeViewer before.
          // Clicking will fall back to the code viewer fallback; it is easy to open the change view when there is a diff source context.
          // Here, priority is given to the shell's file link diversion, the file content is revealed, and the directory is revealed through the file tree.
          onOpenFileLink={onOpenFileLink}
          onOpenExternalUrl={onOpenBrowserUrl}
        >
          {preview.content}
        </MessageResponse>
      </div>
    );
  }

  return (
    <div className="max-h-60 overflow-auto rounded-xl bg-muted/15">
      <CodeBlock code={preview.content} language={preview.language} appTheme={theme} />
    </div>
  );
}

function InlineImageContent({ preview }: { preview: ImageCodeViewerSource }) {
  const { fileService } = useServices();
  const { intl } = useZCodeIntl();
  const [imagePreview, setImagePreview] = useState<FileMediaPreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fileService.readMediaPreview({ path: preview.path }).then((mediaPreview) => {
      if (!cancelled) {
        setImagePreview(mediaPreview);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [fileService, preview.path]);

  if (!imagePreview) {
    return <p>{intl.formatMessage({ id: "chat.toolCall.loading" })}</p>;
  }

  return <img src={imagePreview.dataBase64} alt={preview.title} />;
}

function InlinePlanResult({
  plan,
  planFilePath,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  plan: string;
  planFilePath?: string;
  workspacePath: string;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-3 rounded-xl border border-outline/60 bg-muted/15 p-3">
      {planFilePath ? (
        <div className="flex flex-wrap items-center gap-2 text-ui-base text-on-surface-muted">
          <span>{intl.formatMessage({ id: "chat.toolCall.planFile" })}</span>
          <span className="cursor-default rounded-md bg-muted/70 px-2 py-1 font-mono text-on-surface">
            {planFilePath}
          </span>
        </div>
      ) : null}
      <MessageResponse
        className="size-full min-w-0 break-words whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        workspacePath={workspacePath}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onOpenExternalUrl={onOpenBrowserUrl}
      >
        {plan}
      </MessageResponse>
    </div>
  );
}
