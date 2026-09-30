import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { ToolOutput } from "@/components/ai-elements/tool.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import { extractPlanToolCallContent, getPlanFileLabel } from "@/lib/planToolCall.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { ArrowRightIcon, CheckIcon, CopyIcon, NotepadTextIcon } from "lucide-react";

function isInteractiveDescendant(target: EventTarget | null, card: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest("button, a, input, textarea, select, [role='button']");
  // The card itself has role=button. The old closest will make the card hit itself at any position.
  // As a result "Click on card to open details" never executes. Only real child controls such as copy/expand/text link are intercepted here.
  return interactive !== null && interactive !== card;
}

export function SwitchModeToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const errorText = getToolCallErrorText(toolCall);
  const { markdown, planFilePath } = extractPlanToolCallContent(toolCall, context.workspacePath);
  const snapshotNotice = (
    <ToolSnapshotFieldNotice
      refs={toolCall.snapshotRefs ?? []}
      onLoadFullToolCallFields={
        context.onLoadFullToolCallFields
          ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
          : undefined
      }
    />
  );
  const hasMarkdown = typeof markdown === "string" && markdown.length > 0;
  const [copiedMarkdown, setCopiedMarkdown] = useState<string | null>(null);
  const copied = copiedMarkdown === markdown;

  const openDetail = () => {
    if (!markdown || !context.onOpenPlanDetail) return;
    context.onOpenPlanDetail({
      toolCallId: toolCall.toolId,
      markdown,
      ...(planFilePath ? { planFilePath } : {}),
    });
  };

  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!isInteractiveDescendant(event.target, event.currentTarget)) openDetail();
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    // The keydown of the internal button will continue to bubble up to the entire card, causing the details to be opened repeatedly with one keyboard operation.
    // Shares the interactive element determination with the click path, allowing only the entire card itself to take over Enter / Space.
    if (isInteractiveDescendant(event.target, event.currentTarget)) return;
    event.preventDefault();
    openDetail();
  };

  const handleCopy = () => {
    if (!markdown || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(markdown).then(
      () => setCopiedMarkdown(markdown),
      () => setCopiedMarkdown(null),
    );
  };

  if (hasMarkdown) {
    return (
      <>
        <section
          role={context.onOpenPlanDetail ? "button" : undefined}
          tabIndex={context.onOpenPlanDetail ? 0 : undefined}
          aria-label={intl.formatMessage({ id: "planTool.panel.open" })}
          onClick={handleCardClick}
          onKeyDown={handleCardKeyDown}
          className="group w-full min-w-0 overflow-hidden rounded-xl border border-card-border bg-card text-foreground shadow-xs outline-none transition-colors hover:border-border-hover focus-visible:border-input-border-focused focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <header className="flex h-10 min-w-0 items-start gap-2 px-4 pt-4">
            <div className="flex shrink-0 items-center gap-2">
              <NotepadTextIcon className="size-4 shrink-0 text-foreground-subtle" />
              <h3 className="text-ui-base font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "planTool.panel.planTab" })}
              </h3>
            </div>
            {planFilePath ? (
              <code
                className="min-w-0 truncate text-ui-sm text-foreground-subtlest"
                title={planFilePath}
              >
                {getPlanFileLabel(planFilePath)}
              </code>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({
                  id: copied ? "planTool.panel.copied" : "planTool.panel.copy",
                })}
                onClick={(event) => {
                  event.stopPropagation();
                  handleCopy();
                }}
              >
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              </Button>
            </div>
          </header>
          <div className="relative overflow-hidden">
            {/* After max-height and mask are layered, the long text will calculate the gradient according to the complete content height.
            As a result, there is no bottom fade in the actual visible area; both must fall on the same cropping node. */}
            <div className="max-h-64 overflow-hidden px-4 pt-2 pb-12 [mask-image:linear-gradient(to_bottom,black_0%,black_30%,transparent_100%)]">
              <MessageResponse
                className="min-w-0 break-words text-foreground [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_li]:text-foreground-subtle [&_p]:text-foreground-subtle"
                workspacePath={context.workspacePath}
                theme={context.theme}
                codePreviewSettings={context.codePreviewSettings}
                onOpenCodeViewer={context.onOpenCodeViewer}
                onOpenFileLink={context.onOpenFileLink}
                onOpenExternalUrl={context.onOpenBrowserUrl}
              >
                {markdown}
              </MessageResponse>
            </div>
            <Button
              type="button"
              variant="default"
              size="lg"
              className="absolute bottom-6 left-1/2 h-10 -translate-x-1/2 rounded-full !pr-4.5 pl-6 shadow-xs"
              onClick={(event) => {
                event.stopPropagation();
                openDetail();
              }}
            >
              {intl.formatMessage({ id: "planTool.panel.viewFull" })}
              <ArrowRightIcon data-icon="inline-end" className="size-4" />
            </Button>
          </div>
        </section>
        {snapshotNotice}
      </>
    );
  }

  // The effective information of switch_mode is usually the markdown result, and there should not be another layer of general tool cards.
  // Only when the provider does not provide markdown, or is currently in a failed state, will it fall back to the minimum output block to prevent the UI from being completely blank.
  if (toolCall.output !== undefined || errorText) {
    return (
      <>
        <ToolOutput errorText={errorText} output={errorText ? undefined : toolCall.output} />
        {snapshotNotice}
      </>
    );
  }

  return snapshotNotice;
}
