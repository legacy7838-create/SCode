/* oxlint-disable eslint(max-lines) -- confirmation, publish progress and structured failure details
 * must share the same dock state and action context.
 */
import { memo, useRef } from "react";
import { Circle, CircleAlert, CircleCheck, CircleX, LoaderCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationShareAccessMode } from "@zcode/shared";
import { ConversationSharePermissionPicker } from "@/ConversationSharePermissionPicker.js";
import {
  DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  type ConversationShareDisplayError,
  type ConversationShareDisplayWarnings,
  type ConversationShareProgressPhase,
} from "@/store/conversationShareSelectionStore.js";
import {
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
  resolveConversationShareIssueMessageId,
  resolveConversationShareWarningMessageId,
} from "@/lib/conversationShareError.js";

const SHARE_PROGRESS_PHASES: readonly ConversationShareProgressPhase[] = [
  "collecting",
  "uploading",
  "checking",
];

const SHARE_PHASE_LABEL_IDS: Record<ConversationShareProgressPhase, string> = {
  collecting: "conversationShare.phase.collecting",
  uploading: "conversationShare.phase.uploading",
  checking: "conversationShare.phase.checking",
};

interface ConversationShareConfirmationDockProps {
  selectedCount: number;
  totalCount: number;
  title?: string;
  accessMode?: ConversationShareAccessMode;
  progressLabel?: string;
  progressPhase?: ConversationShareProgressPhase;
  completedArtifacts?: number;
  totalArtifacts?: number;
  onCancel: () => void;
  onBack: () => void;
  onConfirm: () => void;
  onTitleChange?: (title: string) => void;
  onAccessModeChange?: (accessMode: ConversationShareAccessMode) => void;
  disclosureAccepted?: boolean;
  onDisclosureAcceptedChange?: (accepted: boolean) => void;
  pending?: boolean;
  error?: ConversationShareDisplayError | null;
  warnings?: ConversationShareDisplayWarnings | null;
  /**
   * Cancel selection for the whole turn, located by productTurnId (turnOrdinal is only used for
   * display copy).
   */
  onDeselectTurn?: (productTurnId: string) => void;
  onDismissError?: () => void;
  onDismissWarnings?: () => void;
  onCopyRequestId?: () => void;
}

const NOOP = () => {};

function ConversationShareConfirmationDockImpl({
  selectedCount,
  totalCount,
  title = "Share",
  accessMode = DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  progressLabel,
  progressPhase = "collecting",
  completedArtifacts = 0,
  totalArtifacts = 0,
  onCancel,
  onBack,
  onConfirm,
  onTitleChange = NOOP,
  onAccessModeChange = NOOP,
  disclosureAccepted = false,
  onDisclosureAcceptedChange = NOOP,
  pending = false,
  error = null,
  warnings = null,
  onDeselectTurn,
  onDismissError,
  onDismissWarnings,
  onCopyRequestId,
}: ConversationShareConfirmationDockProps) {
  const { intl } = useZCodeIntl();
  const errorDetailsLabel = intl.formatMessage({ id: "conversationShare.issue.details" });
  const disclosureRef = useRef<HTMLElement>(null);
  const checkboxRef = useRef<HTMLInputElement>(null);
  const reviewAnimationRef = useRef<Animation | null>(null);
  const handleConfirm = () => {
    if (!error && !disclosureAccepted) {
      // When it is not confirmed, only the inspection entrance is located, and the click cannot be directly handed over to the release callback; repeated clicks cancel the last animation first.
      disclosureRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
      checkboxRef.current?.focus({ preventScroll: true });
      reviewAnimationRef.current?.cancel();
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        reviewAnimationRef.current =
          disclosureRef.current?.animate(
            [
              { backgroundColor: "var(--color-surface)" },
              {
                backgroundColor:
                  "color-mix(in srgb, var(--color-warning) 20%, var(--color-surface))",
                offset: 0.35,
              },
              { backgroundColor: "var(--color-surface)" },
            ],
            { duration: 600, easing: "ease-out" },
          ) ?? null;
      }
      return;
    }
    onConfirm();
  };
  const publishView = pending || error !== null;
  const progressPercent =
    progressPhase === "collecting" ? 20 : progressPhase === "uploading" ? 58 : 82;
  const failedProgressMessageId =
    progressPhase === "collecting"
      ? "conversationShare.progress.collectingFailed"
      : progressPhase === "uploading"
        ? "conversationShare.progress.uploadingFailed"
        : "conversationShare.progress.checkingFailed";
  const progressPhaseIndex = SHARE_PROGRESS_PHASES.indexOf(progressPhase);
  const accessSummaryMessageId =
    accessMode === "public_readonly"
      ? "conversationShare.permission.linkViewerSummary"
      : accessMode === "public_importable"
        ? "conversationShare.permission.linkEditorSummary"
        : "conversationShare.permission.privateSummary";
  const footerMetaMessageId = error
    ? "conversationShare.publish.failedFooter"
    : pending
      ? "conversationShare.publish.footerMeta"
      : "conversationShare.partial.selectionCount";
  const footerMetaValues: Record<string, string | number> =
    pending && !error
      ? {
          selected: selectedCount,
          access: intl.formatMessage({ id: accessSummaryMessageId }),
        }
      : { selected: selectedCount, total: totalCount };
  const formatValue = (value: number | undefined, code: string): string => {
    if (value === undefined) return "—";
    if (code.includes("size") || code === "payload_size_limit") {
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
      if (value >= 1024) return `${Math.round(value / 1024)} KB`;
      return `${value} B`;
    }
    return String(value);
  };

  return (
    // Share dock used to overlay popover ring, shadow and fixed width in the same input area.
    // Unnecessary layer halo will be generated when switching; only the basic input surface of ordinary Composer is inherited here.
    <section
      data-conversation-share-keep-open="confirmation-dock"
      data-testid="conversation-share-confirmation-dock"
      className="@container/share flex max-h-[70dvh] w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-input-border bg-input text-foreground"
    >
      {/* The form grows taller in narrow panels; the body scrolls independently so the publish action is not pushed out of the viewport. */}
      <div
        data-testid="conversation-share-confirmation-body"
        className="min-h-0 overflow-y-auto overscroll-contain"
      >
        <div
          data-testid="conversation-share-confirmation-header"
          className="flex flex-wrap items-start justify-between gap-3 p-3 pb-2"
        >
          <div className="min-w-0">
            <p
              className={cn(
                "flex items-center gap-1.5 text-ui-base font-medium",
                error && "text-destructive",
              )}
            >
              {error ? <CircleX className="size-4 shrink-0" aria-hidden="true" /> : null}
              {intl.formatMessage({
                id: error
                  ? "conversationShare.publish.failedTitle"
                  : pending
                    ? "conversationShare.generatingLink"
                    : "conversationShare.partial.confirmationTitle",
              })}
            </p>
            {!publishView ? (
              <p className="mt-1 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "conversationShare.partial.selectionHint" })}
              </p>
            ) : error ? (
              <p className="mt-1 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "conversationShare.publish.failedDescription" })}
              </p>
            ) : null}
          </div>
          <span className="shrink-0 pt-0.5 text-ui-sm tabular-nums text-foreground-subtle">
            {pending && !error
              ? `${progressPercent}%`
              : error
                ? intl.formatMessage(
                    { id: "conversationShare.partial.selectedSummary" },
                    { selected: selectedCount, total: totalCount },
                  )
                : intl.formatMessage(
                    { id: "conversationShare.partial.selectionCount" },
                    { selected: selectedCount, total: totalCount },
                  )}
          </span>
        </div>
        {publishView ? (
          <div data-testid="conversation-share-publish-progress" className="grid gap-3 p-3 pb-4">
            <div className="grid gap-2">
              <p role="status" className="text-ui-base font-medium">
                {error ? intl.formatMessage({ id: failedProgressMessageId }) : progressLabel}
              </p>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-background-subtle"
                role="progressbar"
                aria-label={intl.formatMessage({ id: "conversationShare.generatingLink" })}
                aria-valuenow={progressPercent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  data-testid="conversation-share-progress-fill"
                  className={cn(
                    "h-full rounded-full transition-[width]",
                    error ? "bg-destructive" : "bg-primary",
                  )}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
            <div className="grid gap-3 text-ui-sm @min-[640px]/share:grid-cols-3">
              {SHARE_PROGRESS_PHASES.map((phase, index) => {
                const completed = index < progressPhaseIndex;
                const failed = error !== null && phase === progressPhase;
                const active = !error && phase === progressPhase;
                const phaseState = completed
                  ? "complete"
                  : failed
                    ? "failed"
                    : active
                      ? "active"
                      : "pending";
                const PhaseIcon = completed
                  ? CircleCheck
                  : failed
                    ? CircleX
                    : active
                      ? LoaderCircle
                      : phase === "checking"
                        ? ShieldCheck
                        : Circle;
                const phaseDescription = failed
                  ? intl.formatMessage({ id: "conversationShare.phase.failed" })
                  : completed
                    ? intl.formatMessage({
                        id:
                          phase === "collecting"
                            ? "conversationShare.phase.collectingComplete"
                            : "conversationShare.phase.uploadingComplete",
                      })
                    : active && phase === "uploading" && totalArtifacts > 0
                      ? intl.formatMessage(
                          { id: "conversationShare.phase.uploadingActive" },
                          { completed: completedArtifacts, total: totalArtifacts },
                        )
                      : active
                        ? progressLabel
                        : intl.formatMessage({
                            id:
                              phase === "collecting"
                                ? "conversationShare.phase.collectingPending"
                                : phase === "uploading"
                                  ? "conversationShare.phase.uploadingPending"
                                  : "conversationShare.phase.checkingPending",
                          });
                return (
                  <div
                    key={phase}
                    data-testid={`conversation-share-publish-phase-${phase}`}
                    data-phase-state={phaseState}
                    className={cn(
                      "flex min-w-0 items-start gap-2",
                      failed
                        ? "text-destructive"
                        : completed || active
                          ? "text-foreground"
                          : "text-foreground-subtlest",
                    )}
                    aria-current={active || failed ? "step" : undefined}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <PhaseIcon
                        className={cn(
                          "size-4",
                          completed
                            ? "text-success"
                            : failed
                              ? "text-destructive"
                              : active
                                ? "text-foreground"
                                : "text-foreground-subtle",
                        )}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="grid min-w-0 gap-1">
                      <strong className="font-medium">
                        {intl.formatMessage({ id: SHARE_PHASE_LABEL_IDS[phase] })}
                      </strong>
                      <span className="text-foreground-subtle">{phaseDescription}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-2 p-3 pb-0">
              <label className="grid gap-1 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "conversationShare.shareTitle" })}
                <input
                  value={title}
                  onChange={(event) => onTitleChange(event.currentTarget.value)}
                  className="h-9 w-full min-w-0 rounded-lg border border-input-border bg-input px-3 text-ui-base text-foreground outline-none focus:border-input-border-focused"
                />
              </label>
              <ConversationSharePermissionPicker
                variant="compact"
                permission={
                  accessMode === "public_readonly"
                    ? "link-viewer"
                    : accessMode === "public_importable"
                      ? "link-editor"
                      : "private"
                }
                onChange={(permission) =>
                  onAccessModeChange(
                    permission === "link-viewer"
                      ? "public_readonly"
                      : permission === "link-editor"
                        ? "public_importable"
                        : "private",
                  )
                }
              />
            </div>
            {/* Design rationale: the sensitive-information confirmation needs to keep its warning semantics, but the detailed inspection scope is folded into an anchored popover so that long copy cannot stretch the confirmation dock taller. */}
            <section
              ref={disclosureRef}
              data-testid="conversation-share-disclosure"
              role="note"
              className="mx-3 mb-3 mt-3 rounded-xl border border-border border-l-2 border-l-warning bg-surface p-3 text-ui-sm text-foreground"
            >
              <div className="flex items-start gap-2">
                <span
                  data-testid="conversation-share-disclosure-icon"
                  className="hidden size-5 shrink-0 items-center justify-center pt-0.5 text-warning @min-[480px]/share:flex"
                  aria-hidden="true"
                >
                  <ShieldCheck className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    data-testid="conversation-share-disclosure-content-row"
                    className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
                  >
                    <label className="flex min-w-0 items-start gap-2">
                      <input
                        ref={checkboxRef}
                        type="checkbox"
                        data-testid="conversation-share-disclosure-checkbox"
                        checked={disclosureAccepted}
                        onChange={(event) => {
                          reviewAnimationRef.current?.cancel();
                          onDisclosureAcceptedChange(event.currentTarget.checked);
                        }}
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                      />
                      <span className="font-medium leading-5">
                        {intl.formatMessage({ id: "conversationShare.disclosure.checkbox" })}
                      </span>
                    </label>
                    <div
                      data-testid="conversation-share-disclosure-supporting-row"
                      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs leading-5 @min-[480px]/share:ml-auto @min-[480px]/share:justify-end"
                    >
                      <span
                        data-testid="conversation-share-disclosure-description"
                        className="min-w-0 text-ui-xs leading-5 text-foreground-subtle"
                      >
                        {intl.formatMessage({ id: "conversationShare.disclosure.description" })}
                      </span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            data-testid="conversation-share-disclosure-scope-trigger"
                            className="inline-flex shrink-0 items-center text-ui-xs font-medium leading-5 text-foreground-subtle underline underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                          >
                            {intl.formatMessage({
                              id: "conversationShare.disclosure.scope.trigger",
                            })}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          side="top"
                          align="end"
                          sideOffset={8}
                          data-testid="conversation-share-disclosure-scope-content"
                          className="relative w-[min(28rem,calc(100vw-2rem))] gap-0 overflow-visible border-0 bg-transparent p-0 shadow-none"
                        >
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute bottom-[-0.375rem] right-7 z-0 size-3 rotate-45 border-b border-r border-popover-border bg-popover"
                          />
                          <div className="relative z-10 overflow-hidden rounded-xl border border-popover-border bg-popover text-ui-sm text-popover-foreground shadow-lg">
                            <div className="border-b border-border px-4 py-3">
                              <PopoverTitle className="text-ui-base font-semibold">
                                {intl.formatMessage({
                                  id: "conversationShare.disclosure.scope.title",
                                })}
                              </PopoverTitle>
                            </div>
                            <div className="grid gap-3 px-4 py-3">
                              <div className="grid gap-1.5">
                                <p className="text-ui-xs font-medium text-foreground-subtle">
                                  {intl.formatMessage({
                                    id: "conversationShare.disclosure.scope.reviewLabel",
                                  })}
                                </p>
                                <ul className="grid gap-1.5">
                                  {(["conversation", "tools", "generated"] as const).map(
                                    (scope) => (
                                      <li key={scope} className="flex items-start gap-2 leading-5">
                                        <span
                                          aria-hidden="true"
                                          className="mt-2 size-1.5 shrink-0 rounded-full bg-warning"
                                        />
                                        <span>
                                          {intl.formatMessage({
                                            id: `conversationShare.disclosure.scope.${scope}`,
                                          })}
                                        </span>
                                      </li>
                                    ),
                                  )}
                                </ul>
                              </div>
                              <div className="grid gap-1.5">
                                <p className="text-ui-xs font-medium text-foreground-subtle">
                                  {intl.formatMessage({
                                    id: "conversationShare.disclosure.scope.sensitiveLabel",
                                  })}
                                </p>
                                <p className="flex items-start gap-2 leading-5">
                                  <span
                                    aria-hidden="true"
                                    className="mt-2 size-1.5 shrink-0 rounded-full bg-warning"
                                  />
                                  <span>
                                    {intl.formatMessage({
                                      id: "conversationShare.disclosure.scope.sensitive",
                                    })}
                                  </span>
                                </p>
                              </div>
                            </div>
                            <p className="border-t border-border bg-surface px-4 py-3 text-ui-xs text-foreground-subtle">
                              {intl.formatMessage({
                                id: "conversationShare.disclosure.scope.note",
                              })}
                            </p>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </>
        )}
        {error ? (
          // A single line of Toast cannot carry files, rounds and upper limits at the same time; details are fixed in the sharing panel to prevent users from losing the repair path.
          <section
            role="alert"
            data-testid="conversation-share-error-details"
            className={cn(
              "mx-4 max-h-40 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/5 text-ui-sm text-foreground",
              error.messageId ? "mb-2 p-2" : "mb-3 p-2.5",
            )}
          >
            <div
              data-testid="conversation-share-error-row"
              className={cn(
                "flex justify-between gap-3",
                error.messageId ? "items-center" : "mb-1.5 items-start",
              )}
            >
              <p
                data-testid="conversation-share-error-message"
                className="flex min-w-0 flex-1 items-center gap-1.5 font-medium leading-6"
              >
                <span className="min-w-0 flex-1">
                  {error.messageId
                    ? intl.formatMessage({ id: error.messageId })
                    : intl.formatMessage(
                        { id: "conversationShare.error.summary" },
                        { count: error.issueCount },
                      )}
                </span>
                {/* The server request ID is diagnostic information; keeping it permanently in the error area would raise the dock and divert attention from the fix copy, so it is shown in an on-demand Popover instead.*/}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-testid="conversation-share-request-id-trigger"
                      aria-label={errorDetailsLabel}
                      title={errorDetailsLabel}
                      className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-destructive/30"
                    >
                      <CircleAlert className="size-4" aria-hidden="true" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    side="top"
                    sideOffset={6}
                    collisionPadding={16}
                    data-testid="conversation-share-request-id-content"
                    className="w-80 max-w-[calc(100vw-1rem)] gap-2 p-3"
                  >
                    <PopoverTitle className="text-ui-sm font-medium">
                      {errorDetailsLabel}
                    </PopoverTitle>
                    {error.requestId ? (
                      <div className="grid gap-2">
                        <p className="text-ui-xs text-foreground-subtle">
                          {intl.formatMessage({ id: "conversationShare.issue.requestIdLabel" })}
                        </p>
                        <div className="flex min-w-0 items-start gap-2">
                          <code className="min-w-0 flex-1 break-all font-mono text-ui-xs text-foreground select-text">
                            {error.requestId}
                          </code>
                          {onCopyRequestId ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={intl.formatMessage({
                                id: "conversationShare.issue.copyRequestId",
                              })}
                              onClick={onCopyRequestId}
                              className="shrink-0 px-2 text-ui-xs"
                            >
                              {intl.formatMessage({ id: "conversationShare.issue.copyRequestId" })}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <p className="text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({ id: "conversationShare.issue.requestIdMissing" })}
                      </p>
                    )}
                  </PopoverContent>
                </Popover>
              </p>
              {onDismissError ? (
                <button
                  type="button"
                  data-testid="conversation-share-error-dismiss"
                  className="shrink-0 text-ui-xs leading-6 text-foreground-subtle underline underline-offset-2"
                  onClick={onDismissError}
                >
                  {intl.formatMessage({ id: "common.close" })}
                </button>
              ) : null}
            </div>
            {error.messageId ? null : (
              <ul className="grid gap-1.5">
                {error.issues.map((issue, index) => {
                  const messageId = resolveConversationShareIssueMessageId(issue);
                  const values = {
                    turnOrdinal: issue.turnOrdinal ?? "—",
                    artifactDisplayName: issue.artifactDisplayName ?? "—",
                    artifactType: formatConversationShareArtifactType(issue, "en-US"),
                    extension: issue.extension ?? "—",
                    mimeType: issue.mimeType ?? "—",
                    allowedFormats: formatConversationShareAllowedArtifacts(issue, "en-US"),
                    actual: formatValue(issue.actual, issue.code),
                    limit: formatValue(issue.limit, issue.code),
                    phase: issue.phase ?? "—",
                  };
                  return (
                    <li
                      key={`${issue.code}-${issue.rowId ?? "global"}-${index}`}
                      className="grid gap-1"
                    >
                      <p className="leading-5">{intl.formatMessage({ id: messageId }, values)}</p>
                      {issue.productTurnId !== undefined && onDeselectTurn ? (
                        <button
                          type="button"
                          className="w-fit text-ui-xs font-medium text-foreground underline underline-offset-2"
                          onClick={() => onDeselectTurn?.(issue.productTurnId!)}
                        >
                          {intl.formatMessage({ id: "conversationShare.issue.deselectTurn" })}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {error.omittedIssueCount ? (
              <p className="mt-2 text-ui-xs text-foreground-subtle">
                {intl.formatMessage(
                  { id: "conversationShare.issue.more" },
                  { count: error.omittedIssueCount },
                )}
              </p>
            ) : null}
          </section>
        ) : null}
        {warnings && warnings.issues.length > 0 && !pending ? (
          // The publication has been successful, but some files referenced in the text cannot be read and are skipped; to distinguish it from failure, "cancel this round" is not provided.
          <section
            role="status"
            data-testid="conversation-share-warning-details"
            className="mx-4 mb-3 max-h-40 overflow-y-auto rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-ui-sm text-foreground"
          >
            <div className="mb-2 flex items-start justify-between gap-3">
              <p className="font-medium">
                {intl.formatMessage(
                  { id: "conversationShare.warning.summary" },
                  { count: warnings.issueCount },
                )}
              </p>
              {onDismissWarnings ? (
                <button
                  type="button"
                  className="shrink-0 text-ui-xs text-foreground-subtle underline underline-offset-2"
                  onClick={onDismissWarnings}
                >
                  {intl.formatMessage({ id: "common.close" })}
                </button>
              ) : null}
            </div>
            <ul className="grid gap-1.5">
              {warnings.issues.map((issue, index) => (
                <li key={`${issue.code}-${issue.rowId ?? "global"}-${index}`} className="leading-5">
                  {intl.formatMessage(
                    { id: resolveConversationShareWarningMessageId(issue) },
                    {
                      turnOrdinal: issue.turnOrdinal ?? "—",
                      artifactDisplayName: issue.artifactDisplayName ?? "—",
                      artifactType: formatConversationShareArtifactType(issue, "en-US"),
                      extension: issue.extension ?? "—",
                      mimeType: issue.mimeType ?? "—",
                      allowedFormats: formatConversationShareAllowedArtifacts(issue, "en-US"),
                      actual: formatValue(issue.actual, issue.code),
                      limit: formatValue(issue.limit, issue.code),
                      phase: issue.phase ?? "—",
                    },
                  )}
                </li>
              ))}
            </ul>
            {warnings.omittedIssueCount ? (
              <p className="mt-2 text-ui-xs text-foreground-subtle">
                {intl.formatMessage(
                  { id: "conversationShare.issue.more" },
                  { count: warnings.omittedIssueCount },
                )}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
      <div
        data-testid="conversation-share-confirmation-actions"
        className="flex shrink-0 flex-wrap content-center items-center justify-between gap-2 border-t border-input-border px-3 pb-3 pt-2.5"
      >
        <p role="status" className="min-w-0 text-ui-sm leading-4 tabular-nums">
          {intl.formatMessage({ id: footerMetaMessageId }, footerMetaValues)}
        </p>
        <div className="grid w-full min-w-0 grid-cols-2 gap-2 @min-[480px]/share:flex @min-[480px]/share:w-auto @min-[480px]/share:flex-1 @min-[480px]/share:flex-wrap @min-[480px]/share:justify-end">
          {/* Root cause: even when the inner buttons are forced into a row they are still clipped by the outer container; on narrow screens the primary and secondary actions go on separate lines. */}
          <Button
            type="button"
            size="lg"
            disabled={pending || selectedCount === 0 || !title.trim()}
            onClick={handleConfirm}
            data-testid="conversation-share-confirm"
            className="col-span-2 h-auto min-h-9 whitespace-normal break-words px-3 @min-[480px]/share:order-last"
          >
            {intl.formatMessage({
              id: error
                ? "conversationShare.publish.retry"
                : pending
                  ? "conversationShare.partial.publishing"
                  : "conversationShare.partial.confirm",
            })}
          </Button>
          {!pending ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={onBack}
                data-testid="conversation-share-back"
                className="h-auto min-h-9 whitespace-normal break-words px-3"
              >
                {intl.formatMessage({ id: "conversationShare.partial.back" })}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={onCancel}
                className="h-auto min-h-9 whitespace-normal break-words px-3"
              >
                {intl.formatMessage({ id: "conversationShare.partial.cancel" })}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export const ConversationShareConfirmationDock = memo(ConversationShareConfirmationDockImpl);
