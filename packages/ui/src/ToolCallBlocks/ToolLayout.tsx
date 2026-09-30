import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { ToolSummaryRow, type ToolSummaryAction } from "@/ToolCallBlocks/ToolSummaryRow.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

const toolLayoutOpenState = new Map<string, boolean>();
// Memory diagnostic counter: This table only increases but does not decrease according to toolId, and the log is dropped first.
uiMemoryDiagnosticsRegistry.register("toolLayout", () => ({ openState: toolLayoutOpenState.size }));
const TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS = 300;
const TOOL_CONTENT_SHELL_CLASSNAME = "text-popover-foreground outline-none";
const TOOL_CONTENT_SPACING_CLASSNAME = "pt-2";

interface ToolLayoutProps {
  toolId: string;
  persistOpenKey?: string;
  icon: ReactNode;
  showIcon?: boolean;
  canToggle?: boolean;
  forceOpen?: boolean;
  autoOpen?: boolean;
  autoCollapseOnComplete?: boolean;
  kindLabel: ReactNode;
  expandedKindLabel?: ReactNode;
  kindDetail?: ReactNode;
  expandedKindDetail?: ReactNode;
  sourceLabel?: ReactNode;
  primaryText: ReactNode;
  prioritizePrimaryText?: boolean;
  expandedPrimaryText?: ReactNode;
  secondaryText?: ReactNode;
  expandedSecondaryText?: ReactNode;
  summaryContentSeparator?: ReactNode;
  animateSummaryContent?: boolean;
  disableSummaryContentAnimation?: boolean;
  summaryContentKey?: string;
  summaryContentRefreshVersion?: string;
  hideSecondaryTextWhenOpen?: boolean;
  diffCount?: ReactNode;
  hideDiffCountWhenOpen?: boolean;
  statusLabel?: ReactNode;
  statusTooltip?: ReactNode;
  /**
   * The indicator before the status word (such as the empty ring light in the compilation feedback line) is both explicit and implicit with the status word. Place it outside the prompt trigger area:
   * Dotted underlining and hover hints belong only to words, and lights should not be underlined or become another hover target.
   */
  statusIndicator?: ReactNode;
  showStatusLabel?: boolean;
  showFailureStatus?: boolean;
  isRunning?: boolean;
  title?: string;
  expandedTitle?: string;
  content?: ReactNode;
  renderContent?: () => ReactNode;
  summaryAction?: ToolSummaryAction;
}

function ToolLayoutComponent({
  toolId,
  persistOpenKey,
  icon,
  showIcon = true,
  canToggle = true,
  forceOpen = false,
  autoOpen = false,
  autoCollapseOnComplete = false,
  kindLabel,
  expandedKindLabel,
  kindDetail,
  expandedKindDetail,
  sourceLabel,
  primaryText,
  prioritizePrimaryText = false,
  expandedPrimaryText,
  secondaryText,
  expandedSecondaryText,
  summaryContentSeparator,
  animateSummaryContent = false,
  disableSummaryContentAnimation = false,
  summaryContentKey,
  summaryContentRefreshVersion,
  hideSecondaryTextWhenOpen = false,
  diffCount,
  hideDiffCountWhenOpen = false,
  statusLabel,
  statusTooltip,
  statusIndicator,
  showStatusLabel = false,
  showFailureStatus = false,
  isRunning = false,
  title,
  expandedTitle,
  content,
  renderContent,
  summaryAction,
}: ToolLayoutProps) {
  const { intl } = useZCodeIntl();
  const resolvedPersistOpenKey = persistOpenKey ?? toolId;
  const [isOpen, setIsOpen] = useState(
    () => toolLayoutOpenState.get(resolvedPersistOpenKey) ?? false,
  );
  const hasSummaryAction = summaryAction !== undefined;
  const isExpanded = !hasSummaryAction && (forceOpen || (canToggle && isOpen));
  const [shouldRenderContent, setShouldRenderContent] = useState(isExpanded);
  const [isFailureTooltipCopied, setIsFailureTooltipCopied] = useState(false);
  const failureTooltipCopyResetRef = useRef<number | null>(null);
  const contentUnmountDelayRef = useRef<number | null>(null);
  const hasAutoOpenedRef = useRef(false);
  const previousIsRunningRef = useRef(isRunning);
  const shouldShowStatusLabel = (showStatusLabel || showFailureStatus) && statusLabel != null;
  const shouldRenderResolvedContent = !hasSummaryAction && (isExpanded || shouldRenderContent);
  const resolvedContent = shouldRenderResolvedContent
    ? (renderContent?.() ?? content ?? null)
    : null;
  const summaryPrimaryText =
    isExpanded && expandedPrimaryText != null ? expandedPrimaryText : primaryText;
  const summaryKindLabel = isExpanded && expandedKindLabel != null ? expandedKindLabel : kindLabel;
  const summaryKindDetail =
    isExpanded && expandedKindDetail !== undefined ? expandedKindDetail : kindDetail;
  const summarySecondaryText =
    isExpanded && expandedSecondaryText !== undefined
      ? expandedSecondaryText
      : isExpanded && hideSecondaryTextWhenOpen
        ? null
        : secondaryText;
  const summaryTitle = isExpanded && expandedTitle !== undefined ? expandedTitle : title;
  const resolvedSummaryContentKey =
    summaryContentKey ?? `${String(summaryTitle ?? "")}:${String(statusLabel ?? "")}`;
  const shouldShowDiffCount = diffCount != null && !(isExpanded && hideDiffCountWhenOpen);
  // toolcalls are numerous and continuously updated during streaming. Rotating the loading icon will make
  // Animation takes up rendering resources for a long time; the running state is changed to copywriting and status text expression, and the icon remains static.
  const summaryIcon = icon;
  // The running state needs to retain kind copywriting to express that the current tool is still in progress;
  // The non-running state still maintains the lightest text color to prevent summary information from overwhelming the focus.
  const kindLabelClassName = cn(
    "font-medium whitespace-nowrap shrink-0",
    isRunning ? "animated-gradient-text" : "text-foreground-subtlest",
  );

  useEffect(() => {
    const persistedOpen = toolLayoutOpenState.get(resolvedPersistOpenKey);
    setIsOpen(persistedOpen ?? false);
  }, [resolvedPersistOpenKey]);

  useEffect(() => {
    // Tools such as edit/read have the requirement to "automatically expand by default after completion".
    // But forceOpen will completely lock the card so that it cannot be folded.
    // Here it is changed to a one-time autoOpen: it will automatically expand once when the conditions are met for the first time, and the user will still be allowed to close it manually after that.
    if (!autoOpen || hasAutoOpenedRef.current) {
      return;
    }

    toolLayoutOpenState.set(resolvedPersistOpenKey, true);
    setShouldRenderContent(true);
    setIsOpen(true);
    hasAutoOpenedRef.current = true;
  }, [autoOpen, resolvedPersistOpenKey]);

  useEffect(() => {
    const wasRunning = previousIsRunningRef.current;
    previousIsRunningRef.current = isRunning;

    // After the sub-agent is executed, if it continues to be expanded, a long list of sub-tool details will be permanently expanded.
    // The chat stream will quickly become very long, and it is also inconsistent with the set of interactions of "automatically expanding during operation and returning to the summary when completed".
    // It is only automatically closed once at the edge of running -> completed, which does not affect the user's subsequent manual expansion to view details.
    if (autoCollapseOnComplete && !isRunning && wasRunning) {
      toolLayoutOpenState.set(resolvedPersistOpenKey, false);
      setIsOpen(false);
    }
  }, [autoCollapseOnComplete, isRunning, resolvedPersistOpenKey]);

  useEffect(() => {
    if (isExpanded) {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
      setShouldRenderContent(true);
      return;
    }

    if (!shouldRenderContent) {
      return;
    }

    // Children cannot be uninstalled immediately when the tool details are collapsed.
    // Radix will read --radix-collapsible-content-height in the closed animation;
    // If the sub-content is unloaded first, the inner height variable will disappear and inherit the height of the outer historical message.
    // As a result, the details area was temporarily stretched into a super high blank block, and the content below seemed to have disappeared.
    contentUnmountDelayRef.current = window.setTimeout(() => {
      setShouldRenderContent(false);
      contentUnmountDelayRef.current = null;
    }, TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS);

    return () => {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
    };
  }, [isExpanded, shouldRenderContent]);

  useEffect(() => {
    return () => {
      if (failureTooltipCopyResetRef.current !== null) {
        window.clearTimeout(failureTooltipCopyResetRef.current);
      }
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
      }
    };
  }, []);

  const handleCopyFailureTooltip = () => {
    if (typeof statusTooltip !== "string" || statusTooltip.trim().length === 0) {
      return;
    }

    navigator.clipboard.writeText(statusTooltip).then(() => {
      setIsFailureTooltipCopied(true);
      if (failureTooltipCopyResetRef.current !== null) {
        window.clearTimeout(failureTooltipCopyResetRef.current);
      }
      failureTooltipCopyResetRef.current = window.setTimeout(() => {
        setIsFailureTooltipCopied(false);
        failureTooltipCopyResetRef.current = null;
      }, 1500);
    });
  };

  const statusWordNode =
    shouldShowStatusLabel && statusLabel != null ? (
      statusTooltip ? (
        // The content in the failed state is no longer forced to expand, and the error details are changed to the status text tooltip.
        // In this way, the edit card maintains the same expansion logic as the success state, and at the same time, the error reason can still be obtained when hovering.
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="whitespace-nowrap underline decoration-dotted underline-offset-2 cursor-help">
                {statusLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-96">
              <div className="flex max-w-96 items-center gap-2">
                <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {statusTooltip}
                </span>
                {typeof statusTooltip === "string" && statusTooltip.trim().length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-md"
                    className="shrink-0"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleCopyFailureTooltip();
                    }}
                    title={intl.formatMessage({
                      id: isFailureTooltipCopied
                        ? "chat.toolCall.copyError.copied"
                        : "chat.toolCall.copyError",
                    })}
                    aria-label={intl.formatMessage({
                      id: isFailureTooltipCopied
                        ? "chat.toolCall.copyError.copied"
                        : "chat.toolCall.copyError",
                    })}
                  >
                    {isFailureTooltipCopied ? (
                      <CheckIcon className="size-3" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                  </Button>
                ) : null}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <span className="whitespace-nowrap">{statusLabel}</span>
      )
    ) : null;
  const statusNode =
    statusWordNode !== null && statusIndicator != null ? (
      <span className="inline-flex shrink-0 items-center gap-1.5">
        {statusIndicator}
        {statusWordNode}
      </span>
    ) : (
      statusWordNode
    );

  return (
    <Collapsible
      open={!hasSummaryAction && (forceOpen || (canToggle && isOpen))}
      onOpenChange={(open) => {
        if (hasSummaryAction || forceOpen) {
          return;
        }
        toolLayoutOpenState.set(resolvedPersistOpenKey, open);
        if (open) {
          setShouldRenderContent(true);
        }
        setIsOpen(open);
      }}
      className="w-full flex flex-col"
    >
      <ToolSummaryRow
        action={summaryAction}
        animateContent={animateSummaryContent}
        canToggle={canToggle}
        contentKey={resolvedSummaryContentKey}
        contentRefreshVersion={summaryContentRefreshVersion}
        diffCount={shouldShowDiffCount ? diffCount : undefined}
        disableContentAnimation={disableSummaryContentAnimation}
        forceOpen={forceOpen}
        icon={summaryIcon}
        isExpanded={isExpanded}
        kindDetail={summaryKindDetail}
        kindLabel={summaryKindLabel}
        kindLabelClassName={kindLabelClassName}
        primaryText={summaryPrimaryText}
        prioritizePrimaryText={prioritizePrimaryText}
        secondaryText={summarySecondaryText}
        separator={summaryContentSeparator}
        showIcon={showIcon}
        sourceLabel={sourceLabel}
        statusNode={statusNode}
        title={summaryTitle}
        toggleAriaLabel={intl.formatMessage({
          id: isExpanded ? "chat.toolCall.collapseDetails" : "chat.toolCall.expandDetails",
        })}
        toolId={toolId}
      />
      {!hasSummaryAction && canToggle ? (
        <CollapsibleContent className={TOOL_CONTENT_SHELL_CLASSNAME}>
          {/* When padding is directly hung on the height animation node, the main body will still stop at 8px after returning to zero.
              It disappears instantly until delayed uninstallation switches display:none. After being placed inside, it will be overflowed by the outer layer.
              Continuously crop to 0 with the height of the animation, retaining the original spacing and not changing the 300ms measurement protection. */}
          <div className={TOOL_CONTENT_SPACING_CLASSNAME}>{resolvedContent}</div>
        </CollapsibleContent>
      ) : !hasSummaryAction && forceOpen ? (
        <div className={cn(TOOL_CONTENT_SHELL_CLASSNAME, TOOL_CONTENT_SPACING_CLASSNAME)}>
          {resolvedContent}
        </div>
      ) : null}
    </Collapsible>
  );
}

export const ToolLayout = memo(ToolLayoutComponent);
ToolLayout.displayName = "ToolLayout";
