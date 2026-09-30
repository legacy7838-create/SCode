import { memo } from "react";
import { AlertCircle, AlertTriangle, Info, LoaderCircle } from "lucide-react";
import type {
  ConversationShareFailureIssue,
  ConversationSharePreflightResult,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
  resolveConversationShareIssueMessageId,
  resolveConversationShareWarningMessageId,
} from "@/lib/conversationShareError.js";

export type ConversationShareSelectionPreflightState =
  | { status: "idle" | "checking" }
  | ({ status: "ready" | "stale" } & ConversationSharePreflightResult);

// The default object of the memo component will destroy reference stability every time it is created; the idle default value is only for reading.
const DEFAULT_PREFLIGHT: ConversationShareSelectionPreflightState = { status: "idle" };

interface ConversationShareSelectionDockProps {
  selectedCount: number;
  totalCount: number;
  onCancel: () => void;
  onNext: () => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  /**
   * Deselect the entire round. Only accept productTurnId: turnOrdinal is service press all turnHeader
   * The display sequence number of the number. Use it to check the per-query list of the UI and it will be canceled to other rounds.
   */
  onDeselectTurn?: (productTurnId: string) => void;
  /** Transmission blocking (network/RPC jitter) has no operable objects and can only be pre-checked as a whole. */
  onRetryPreflight?: () => void;
  preflight?: ConversationShareSelectionPreflightState;
  pending?: boolean;
}

function ConversationShareSelectionDockImpl({
  selectedCount,
  totalCount,
  onCancel,
  onNext,
  onSelectAll,
  onDeselectAll,
  onDeselectTurn,
  onRetryPreflight,
  preflight = DEFAULT_PREFLIGHT,
  pending = false,
}: ConversationShareSelectionDockProps) {
  const { intl } = useZCodeIntl();
  const selectAllState =
    selectedCount === 0 ? false : selectedCount === totalCount ? true : ("indeterminate" as const);
  const bulkActionMessageId =
    totalCount > 0 && selectedCount === totalCount
      ? "conversationShare.partial.deselectAll"
      : "conversationShare.partial.selectAll";
  const blockingIssues = "blockingIssues" in preflight ? preflight.blockingIssues : [];
  const skippableWarnings = "skippableWarnings" in preflight ? preflight.skippableWarnings : [];
  const deferredIssues = "deferredIssues" in preflight ? preflight.deferredIssues : [];
  const checking =
    preflight.status === "checking" ||
    preflight.status === "stale" ||
    (preflight.status === "idle" && selectedCount > 0);
  const statusCount = blockingIssues.length || skippableWarnings.length || deferredIssues.length;
  const statusLabel = checking
    ? intl.formatMessage({ id: "conversationShare.partial.preflightChecking" })
    : blockingIssues.length > 0
      ? intl.formatMessage({ id: "conversationShare.partial.preflightBlocked" })
      : skippableWarnings.length > 0
        ? intl.formatMessage(
            { id: "conversationShare.partial.preflightSkipped" },
            { count: skippableWarnings.length },
          )
        : deferredIssues.length > 0
          ? intl.formatMessage({ id: "conversationShare.partial.preflightDeferred" })
          : "";
  const formatValue = (value: number | undefined, code: string): string => {
    if (value === undefined) return "—";
    if (code.includes("size") || code === "payload_size_limit") {
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
      if (value >= 1024) return `${Math.round(value / 1024)} KB`;
      return `${value} B`;
    }
    return String(value);
  };
  const formatIssueValues = (issue: ConversationShareFailureIssue) => ({
    turnOrdinal: issue.turnOrdinal ?? "—",
    artifactDisplayName: issue.artifactDisplayName ?? "—",
    artifactType: formatConversationShareArtifactType(issue, "en-US"),
    extension: issue.extension ?? "—",
    mimeType: issue.mimeType ?? "—",
    allowedFormats: formatConversationShareAllowedArtifacts(issue, "en-US"),
    actual: formatValue(issue.actual, issue.code),
    limit: formatValue(issue.limit, issue.code),
    phase: issue.phase ?? "—",
  });

  return (
    // Share dock used to overlay popover ring, shadow and fixed width in the same input area.
    // Unnecessary layer halo will be generated when switching; only the basic input surface of ordinary Composer is inherited here.
    <section
      data-conversation-share-keep-open="selection-dock"
      data-testid="conversation-share-selection-dock"
      className="w-full overflow-hidden rounded-2xl border border-input-border bg-input text-foreground"
    >
      <p
        data-testid="conversation-share-selection-stage-hint"
        className="p-3.5 text-ui-base font-medium leading-5"
      >
        {intl.formatMessage({ id: "conversationShare.partial.selectionStageHint" })}
      </p>
      <div
        data-testid="conversation-share-selection-actions"
        className="flex flex-wrap content-center items-center justify-between gap-3 px-3 pb-3"
      >
        <div
          data-testid="conversation-share-bulk-actions"
          className="flex h-8 shrink-0 items-center gap-3"
        >
          <div data-testid="conversation-share-bulk-toggle" className="flex items-center gap-1">
            <div
              data-testid="conversation-share-bulk-checkbox-slot"
              className="flex size-5 shrink-0 items-center justify-center"
            >
              <Checkbox
                aria-label={intl.formatMessage({ id: bulkActionMessageId })}
                checked={selectAllState}
                disabled={pending || checking || totalCount === 0}
                checkIconStrokeWidth={1.33}
                onCheckedChange={(checked) => {
                  if (checked === true) onSelectAll();
                  else if (checked === false) onDeselectAll();
                }}
                className="size-3.5 rounded-sm [&_[data-slot=checkbox-checked-icon]]:size-2.5 [&_[data-slot=checkbox-indeterminate-icon]]:size-2.5"
              />
            </div>
            {/* Fixed width will split the English labels; keep a single line according to the content width, and let the operation group wrap as a whole. */}
            <span
              data-testid="conversation-share-bulk-label"
              className="shrink-0 whitespace-nowrap text-ui-sm leading-4"
            >
              {intl.formatMessage({ id: bulkActionMessageId })}
            </span>
          </div>
          <p role="status" className="shrink-0 text-ui-sm leading-4 tabular-nums">
            {intl.formatMessage(
              { id: "conversationShare.partial.selectionCount" },
              { selected: selectedCount, total: totalCount },
            )}
          </p>
          <span className="flex size-5 shrink-0 items-center justify-center">
            {statusCount > 0 || checking ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-testid="conversation-share-selection-preflight-status"
                    aria-label={statusLabel}
                    title={statusLabel}
                    aria-busy={checking}
                    className="flex size-5 items-center justify-center rounded-md text-foreground-subtle outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                  >
                    {checking ? (
                      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                    ) : blockingIssues.length > 0 ? (
                      <AlertCircle className="size-4 text-destructive" aria-hidden="true" />
                    ) : skippableWarnings.length > 0 ? (
                      <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
                    ) : (
                      <Info className="size-4" aria-hidden="true" />
                    )}
                    <span className="sr-only">{statusLabel}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  collisionPadding={12}
                  data-testid="conversation-share-selection-preflight-popover"
                  className="w-96 max-w-[calc(100vw-1.5rem)] gap-2 p-3"
                >
                  <PopoverTitle className="text-ui-sm font-medium">{statusLabel}</PopoverTitle>
                  {!checking ? (
                    <ul className="grid max-h-56 gap-2 overflow-y-auto text-ui-sm">
                      {[...blockingIssues, ...skippableWarnings, ...deferredIssues]
                        .slice(0, 5)
                        .map((issue, index) => (
                          <li
                            key={`${issue.code}-${issue.rowId ?? "global"}-${index}`}
                            className="grid gap-1"
                          >
                            <span>
                              {intl.formatMessage(
                                {
                                  id: blockingIssues.includes(issue)
                                    ? resolveConversationShareIssueMessageId(issue)
                                    : resolveConversationShareWarningMessageId(issue),
                                },
                                formatIssueValues(issue),
                              )}
                            </span>
                            {blockingIssues.includes(issue) &&
                            issue.productTurnId !== undefined &&
                            onDeselectTurn ? (
                              <button
                                type="button"
                                className="w-fit text-ui-xs font-medium text-foreground underline underline-offset-2"
                                onClick={() => onDeselectTurn(issue.productTurnId!)}
                              >
                                {intl.formatMessage({ id: "conversationShare.issue.deselectTurn" })}
                              </button>
                            ) : null}
                            {blockingIssues.includes(issue) &&
                            issue.scope === "transport" &&
                            onRetryPreflight ? (
                              <button
                                type="button"
                                data-testid="conversation-share-preflight-retry"
                                className="w-fit text-ui-xs font-medium text-foreground underline underline-offset-2"
                                onClick={onRetryPreflight}
                              >
                                {intl.formatMessage({
                                  id: "conversationShare.issue.retryPreflight",
                                })}
                              </button>
                            ) : null}
                          </li>
                        ))}
                    </ul>
                  ) : null}
                </PopoverContent>
              </Popover>
            ) : null}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={pending}
            onClick={onCancel}
            className="px-3"
          >
            {intl.formatMessage({ id: "conversationShare.partial.cancel" })}
          </Button>
          <Button
            type="button"
            size="lg"
            disabled={pending || checking || blockingIssues.length > 0 || selectedCount === 0}
            onClick={onNext}
            data-testid="conversation-share-next"
            className="px-3"
          >
            {/* Preflight progress is already shown by the status portal, and the button is only prevented from advancing to the next step early by its disabled status. */}
            {intl.formatMessage({ id: "conversationShare.partial.next" })}
          </Button>
        </div>
      </div>
    </section>
  );
}

export const ConversationShareSelectionDock = memo(ConversationShareSelectionDockImpl);
