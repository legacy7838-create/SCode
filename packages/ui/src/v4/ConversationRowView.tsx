/* oxlint-disable eslint(max-lines) -- v4's per-row render dispatch is funneled into one place (one
 * memo leaf per row kind + a timelineMarker divider), because splitting it would scatter the
 * row-kind cross-reference.
 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  CopyIcon,
  FileClockIcon,
  FileIcon,
  GitBranchIcon,
  GoalIcon,
  PencilIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TrendingUpDownIcon,
  XIcon,
} from "lucide-react";
import {
  TID_V4_EDIT,
  TID_V4_EDIT_ATTACHMENT_REMOVE,
  TID_V4_EDIT_CANCEL,
  TID_V4_EDIT_INPUT,
  TID_V4_EDIT_SUBMIT,
  TID_V4_EDIT_REWIND_WORKSPACE,
  TID_V4_FEEDBACK_DISLIKE,
  TID_V4_FEEDBACK_LIKE,
  TID_V4_FORK,
  TID_V4_ROW,
  TID_V4_ROW_ATTACHMENTS,
  testId,
} from "@zcode/shared";
import type {
  AttachmentRef,
  ArtifactRow,
  AssistantTextRow,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
  HookInvocationRow,
  ReasoningRow,
  SubagentRow,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import { AssistantPreviewCards } from "@/AssistantPreviewCards.js";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { PdfViewerRangeSource } from "@/components/ui/pdf-viewer.js";
import {
  MessageAction,
  MessageActions,
  MessageResponse,
} from "@/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";
import {
  readWorkflowName,
  readWorkflowRetuneCall,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { WorkflowRetuneRow } from "@/ToolCallBlocks/renderers/WorkflowRetuneRow.js";
import { workflowRunSettingsCeiling } from "@/components/workflow-timeline/workflowRunSettings.js";
import { isAmendWorkflowToolCall } from "@/lib/workflowToolNames.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { resolveWorkflowRunOpenToolCallId } from "@/v4/workflowRunCardJoin.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import {
  FileDisplayIcon,
  FileDisplayInline,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import {
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  isConversationReasoningRowVisible,
  type ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import {
  countComposerPromptContexts,
  parseComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import { ConversationFileRewindDialog } from "@/v4/ConversationFileRewindDialog.js";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import {
  ConversationUserInputEpilogue,
  splitUserInputEpilogue,
} from "@/v4/ConversationUserInputEpilogue.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { formatMessageTimeLabel } from "@/v4/messageTimeLabel.js";
import { parseConversationShareContext } from "@/lib/conversationShareContext.js";

function RowShell({
  rowId,
  children,
  className = "",
}: {
  rowId: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-row-id={rowId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={cn(className)}
    >
      {children}
    </div>
  );
}

const ArtifactRowView = memo(function ArtifactRowView({ row }: { row: ArtifactRow }) {
  return (
    <RowShell rowId={row.rowId} className="px-4 py-1">
      <div className="flex items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2">
        <FileIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-base text-foreground">{row.displayName}</p>
          <p className="text-ui-sm text-foreground-subtle">
            {row.artifactType.toUpperCase()} · {row.sizeBytes} bytes
          </p>
        </div>
      </div>
    </RowShell>
  );
});

/** Copy the row text: an icon ghost button + a 1200ms checked state (aligned with the legacy
 * message copy). The label/tooltip must be handed in by the caller as i18n copy; hardcoding a
 * language is forbidden.
 */
const CopyRowAction = memo(function CopyRowAction({
  text,
  rowId,
  label,
  tooltip = label,
}: {
  text: string;
  rowId: number;
  label: string;
  tooltip?: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!text || !navigator.clipboard) return;
    void runUserActionAsync({
      input: { featureId: "conversation.history.feedback", action: "copy", trigger: "button" },
      operation: () => navigator.clipboard.writeText(text),
      completed: { resultSource: "platform_result" },
      failureStage: "clipboard_write",
    }).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);
  return (
    <MessageAction
      aria-label={label}
      label={label}
      tooltip={tooltip}
      data-testid={`v4-copy-${rowId}`}
      disabled={text.length === 0}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
    </MessageAction>
  );
});

type UserInputEditHandler = (
  target: ConversationRowTarget,
  newText: string,
  attachments?: readonly AttachmentRef[],
  workspaceMode?: "preserve" | "rewind",
) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;

type AssistantMessageFeedback = "like" | "dislike";

function getAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

export type AssistantFeedbackHandler = (
  target: ConversationRowTarget,
  feedback: AssistantMessageFeedback | null,
) => Promise<boolean | void> | boolean | void;

export function readAssistantFeedback(row: AssistantTextRow): AssistantMessageFeedback | null {
  // feedback is an additive V4 row field; defaults to null for compatibility with old CLI rows.
  const feedback = row.feedback;
  return feedback === "like" || feedback === "dislike" ? feedback : null;
}

export interface EditWorkspaceRewindAvailability {
  enabled: boolean;
  reason: "available" | "noFiles" | "reverted" | "running" | "unavailable";
}

interface ConversationRowViewProps {
  row: ConversationRow;
  /**
   * The render context (theme/codePreviewSettings/workspacePath); the host guarantees a stable
   * reference.
   */
  context: ConversationRowRenderContext;
  /** The fork entry point on a completed assistant row (forkAssistant command). */
  onFork?: (target: ConversationRowTarget) => void;
  /**
   * Compare-and-set for assistant entity feedback; the UI updates optimistically first and rolls
   * back when the command fails.
   */
  onFeedbackChange?: AssistantFeedbackHandler;
  /**
   * Protocol compatibility: the upper layer may still supply a retryTurn capability, but the
   * product UI does not render a plain retry entry point.
   */
  onRetry?: (target: ConversationRowTarget) => void;
  /**
   * The edit entry point on a user row (editUserQuery command, which replaces that turn with the
   * inline-edited text).
   */
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  /**
   * Removes the duplicate left guide and indentation of Reasoning content when nested inside a tool
   * Group.
   */
  reasoningContentVariant?: "default" | "nested";
  /**
   * Renderer-only submit state; it is not written into protocol rows and does not impersonate a
   * drained historical fact.
   */
  userInputStatus?: string;
  /**
   * One turn is one reply to the user: a non-final text segment shows no action at all (neither
   * copy nor fork); the entry points live only on the turn's final segment.
   */
  hideAssistantActions?: boolean;
  /** TurnGroup has to defer rendering the turn-level actions until after the file summary. */
  deferAssistantActions?: boolean;
  /**
   * The copy content of the final segment = all text segments of the whole turn merged (not just
   * the last one).
   */
  assistantCopyText?: string;
  /**
   * Assistant Preview Cards are computed and passed down by TurnGroup alone, for the turn's final
   * terminal assistant text.
   */
  assistantPreviewCards?: AssistantPreviewCard[];
  /**
   * A one-shot auto-open identity passed down only when the current renderer observes running ->
   * complete.
   */
  assistantPreviewCardsAutoOpenKey?: string;
  /**
   * Assistant code-comment cards are computed and passed down by TurnGroup alone, for the turn's
   * final terminal-state assistant text.
   */
  assistantCodeCommentCards?: AssistantCodeCommentCard[];
  /**
   * TurnGroup makes the single call on whether the turn's body hides the code-comment protocol
   * text.
   */
  assistantCodeCommentProjectionEnabled?: boolean;
}

// ── Split each row into independent memo leaves: when the parent under the virtual list is re-rendered, only the rows whose props have actually changed are re-rendered;
// Line types that require hooks (assistantText/toolCall) hook calls stay within their respective components to avoid
// A conditional hook appears in the switch distribution component. ──

/**
 * Attachment rendering: the row still only stores an AttachmentRef; when an image mounts its
 * thumbnail is read in chunks keyed by session/ref, and clicking reuses the already-loaded URL to
 * enter the shared preview. Non-images, and images that failed to load, stay purely presentational,
 * so there is no fake hand cursor that does nothing.
 */
const UserInputAttachmentList = memo(function UserInputAttachmentList({
  attachments,
  attachmentIndices,
  entityId,
  attachmentKind = "all",
  directItems = false,
  onRemove,
  rowId,
  sessionId,
  readAttachment,
  readAttachmentRange,
}: {
  attachments: readonly AttachmentRef[] | undefined;
  /**
   * After deleting an attachment in edit mode, its original index in the persistent FilePart list
   * is still preserved.
   */
  attachmentIndices?: readonly number[];
  entityId?: string;
  attachmentKind?: "all" | "media" | "file";
  directItems?: boolean;
  onRemove?: (index: number) => void;
  rowId: number;
  sessionId?: string;
  readAttachment?: NonNullable<ConversationRowRenderContext["readAttachment"]>;
  readAttachmentRange?: NonNullable<ConversationRowRenderContext["readAttachmentRange"]>;
}) {
  const { intl } = useZCodeIntl();
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [failedRefs, setFailedRefs] = useState<ReadonlySet<string>>(() => new Set());
  const [thumbnailUrls, setThumbnailUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Visible message line prefetch image/video Blob: the image is displayed directly, and the first frame of the video is displayed by the control-free player;
  // The video URL is also reused by the gallery to prevent users from reading large files again after clicking.
  const [videoPreview, setVideoPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [videoPreviewRef, setVideoPreviewRef] = useState<string | null>(null);
  const [videoPreviewLoading, setVideoPreviewLoading] = useState(false);
  const [videoPreviewError, setVideoPreviewError] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfPreviewLoading, setPdfPreviewLoading] = useState(false);
  const [pdfPreviewError, setPdfPreviewError] = useState(false);
  const [pdfPreviewRef, setPdfPreviewRef] = useState<string | null>(null);
  const pdfPreviewUrlRef = useRef<string | null>(null);
  const pdfPreviewRequestRef = useRef(0);
  const pdfPreviewAbortRef = useRef<AbortController | null>(null);
  const videoPreviewUrlRef = useRef<string | null>(null);
  const videoPreviewRequestRef = useRef(0);
  const videoPreviewAbortRef = useRef<AbortController | null>(null);
  const thumbnailUrlsRef = useRef<Map<string, string>>(new Map());
  const thumbnailObjectUrlsRef = useRef<Set<string>>(new Set());
  const previewOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const previewVideoOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const previewPdfOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openPdf",
  });
  const previewUnavailableLabel = intl.formatMessage({
    id: "chat.attachments.preview.unavailable",
  });

  useEffect(() => {
    if (attachmentKind === "file" || !attachments || !sessionId || !readAttachment) {
      return;
    }
    let cancelled = false;
    // Just discarding the read result does not stop the underlying chunked transfer, it is still possible to pull the full video after the message line is unloaded.
    // The prefetch life cycle must pass AbortSignal throughout the transport to release file IO and IPC resources in a timely manner.
    const controller = new AbortController();
    const mediaAttachments = attachments.flatMap((attachment, index) =>
      attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/")
        ? [{ attachment, index }]
        : [],
    );

    // The V4 virtual list only mounts visible rows to avoid scanning the entire history. Video still uses stable row target,
    // A durable artifact that ensures that the thumbnail image comes from the current message when the same path is sent multiple times.
    void Promise.all(
      mediaAttachments.map(async ({ attachment, index }) => {
        const ref = attachment.previewRef ?? attachment.ref;
        const isVideo = attachment.mime.startsWith("video/");
        try {
          const result = await readAttachment({
            sessionId,
            ref,
            signal: controller.signal,
            ...(isVideo ? { mediaType: attachment.mime } : {}),
            ...(isVideo && entityId
              ? {
                  target: { rowId, entityId },
                  attachmentIndex: attachmentIndices?.[index] ?? index,
                }
              : {}),
          });
          if (cancelled) return;
          const isLocalUrl = "url" in result;
          const url = isLocalUrl
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], {
                  type: result.mediaType,
                }),
              );
          if (!isLocalUrl) thumbnailObjectUrlsRef.current.add(url);
          if (cancelled) {
            if (!isLocalUrl) {
              thumbnailObjectUrlsRef.current.delete(url);
              URL.revokeObjectURL(url);
            }
            return;
          }
          thumbnailUrlsRef.current.set(ref, url);
          setThumbnailUrls(new Map(thumbnailUrlsRef.current));
        } catch (error) {
          if (cancelled || controller.signal.aborted) return;
          if (!isVideo) setFailedRefs((current) => new Set(current).add(ref));
          logger.warn(
            `[v4-attachment-preview] failed to read sent ${isVideo ? "video" : "image"} thumbnail`,
            error,
          );
        }
      }),
    );

    return () => {
      controller.abort();
      cancelled = true;
      // Desktop local video returns a custom protocol URL, not a Blob created by renderer;
      // Only release the object URL created by this effect to avoid treating local media URLs as Blob life cycle management.
      for (const url of thumbnailObjectUrlsRef.current) URL.revokeObjectURL(url);
      thumbnailObjectUrlsRef.current.clear();
      thumbnailUrlsRef.current.clear();
    };
  }, [attachmentIndices, attachmentKind, attachments, entityId, readAttachment, rowId, sessionId]);

  // ── sent video preview read: staging semantics are retained as is ──
  const releaseVideoPreviewUrl = useCallback(() => {
    if (!videoPreviewUrlRef.current) return;
    URL.revokeObjectURL(videoPreviewUrlRef.current);
    videoPreviewUrlRef.current = null;
  }, []);

  const cancelVideoPreviewRead = useCallback(() => {
    videoPreviewRequestRef.current += 1;
    videoPreviewAbortRef.current?.abort();
    videoPreviewAbortRef.current = null;
  }, []);

  useEffect(
    () => () => {
      cancelVideoPreviewRead();
      releaseVideoPreviewUrl();
    },
    [cancelVideoPreviewRead, releaseVideoPreviewUrl],
  );

  const closeVideoPreview = useCallback(() => {
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
  }, [cancelVideoPreviewRead, releaseVideoPreviewUrl]);

  const closePdfPreview = useCallback(() => {
    pdfPreviewRequestRef.current += 1;
    pdfPreviewAbortRef.current?.abort();
    pdfPreviewAbortRef.current = null;
    if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
    pdfPreviewUrlRef.current = null;
    setPdfPreview(null);
    setPdfPreviewRef(null);
    setPdfPreviewLoading(false);
    setPdfPreviewError(false);
  }, []);

  useEffect(
    () => () => {
      closePdfPreview();
    },
    [closePdfPreview],
  );

  const openVideoPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number, galleryIndex: number) => {
      if (!sessionId || !readAttachment) return;
      const ref = attachment.previewRef ?? attachment.ref;
      cancelVideoPreviewRead();
      const thumbnailUrl = thumbnailUrlsRef.current.get(ref);
      if (thumbnailUrl) {
        releaseVideoPreviewUrl();
        setPreviewIndex(galleryIndex);
        setPreviewOpen(true);
        setVideoPreviewRef(ref);
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        });
        setVideoPreviewLoading(false);
        setVideoPreviewError(false);
        return;
      }
      const requestId = videoPreviewRequestRef.current;
      const abortController = new AbortController();
      videoPreviewAbortRef.current = abortController;
      releaseVideoPreviewUrl();
      setPreviewIndex(galleryIndex);
      setPreviewOpen(true);
      setVideoPreviewRef(ref);
      setVideoPreview({
        filename: attachment.fileName,
        mediaType: attachment.mime,
      });
      setVideoPreviewLoading(true);
      setVideoPreviewError(false);
      try {
        const result = await readAttachment({
          sessionId,
          ref,
          mediaType: attachment.mime,
          // When there is an entityId, read accurately according to the stable row target; otherwise, it returns to ref matching.
          ...(entityId ? { target: { rowId, entityId }, attachmentIndex } : {}),
          signal: abortController.signal,
        });
        if (videoPreviewRequestRef.current !== requestId) return;
        const isLocalUrl = "url" in result;
        const url = isLocalUrl
          ? result.url
          : URL.createObjectURL(
              new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
            );
        if (videoPreviewRequestRef.current !== requestId) {
          if (!isLocalUrl) URL.revokeObjectURL(url);
          return;
        }
        videoPreviewUrlRef.current = isLocalUrl ? null : url;
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
      } catch (error) {
        if (videoPreviewRequestRef.current !== requestId) return;
        // A read failure once permanently disabled the attachment entry, and the ability to open the Dialog was incorrectly tied to the read result.
        // The failure only belongs to this preview; the entry is retained so that it is re-read every time it is opened and the error is displayed in the Dialog.
        setVideoPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent media", error);
      } finally {
        if (videoPreviewRequestRef.current === requestId) {
          videoPreviewAbortRef.current = null;
          setVideoPreviewLoading(false);
        }
      }
    },
    [cancelVideoPreviewRead, entityId, readAttachment, releaseVideoPreviewUrl, rowId, sessionId],
  );

  const openPdfPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number) => {
      if (!sessionId || (!readAttachment && !readAttachmentRange)) return;
      const ref = attachment.previewRef ?? attachment.ref;
      pdfPreviewRequestRef.current += 1;
      const requestId = pdfPreviewRequestRef.current;
      pdfPreviewAbortRef.current?.abort();
      const abortController = new AbortController();
      pdfPreviewAbortRef.current = abortController;
      if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
      pdfPreviewUrlRef.current = null;
      setPdfPreviewRef(ref);
      setPdfPreview({ filename: attachment.fileName, mediaType: "application/pdf" });
      setPdfPreviewLoading(true);
      setPdfPreviewError(false);
      try {
        const target = entityId ? { target: { rowId, entityId }, attachmentIndex } : {};
        if (readAttachmentRange) {
          const firstRange = await readAttachmentRange({
            sessionId,
            ref,
            ...target,
            offset: 0,
            limit: 256 * 1024,
            signal: abortController.signal,
          });
          const source: PdfViewerRangeSource = {
            totalBytes: firstRange.totalBytes,
            initialData: firstRange.bytes,
            requestRange: async (offset, limit) => {
              const range = await readAttachmentRange({
                sessionId,
                ref,
                ...target,
                offset,
                limit,
                signal: abortController.signal,
              });
              return range.bytes;
            },
          };
          if (pdfPreviewRequestRef.current !== requestId) return;
          setPdfPreview({
            filename: attachment.fileName,
            mediaType: firstRange.mediaType,
            pdfSource: source,
          });
          return;
        }
        if (!readAttachment) return;
        const result = await readAttachment({
          sessionId,
          ref,
          ...target,
          signal: abortController.signal,
        });
        if (pdfPreviewRequestRef.current !== requestId) return;
        const url =
          "url" in result
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
              );
        if (!("url" in result)) pdfPreviewUrlRef.current = url;
        setPdfPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
      } catch (error) {
        if (pdfPreviewRequestRef.current !== requestId) return;
        setPdfPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent PDF", error);
      } finally {
        if (pdfPreviewRequestRef.current === requestId) {
          pdfPreviewAbortRef.current = null;
          setPdfPreviewLoading(false);
        }
      }
    },
    [entityId, readAttachment, readAttachmentRange, rowId, sessionId],
  );

  const visibleAttachments = (attachments ?? [])
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => {
      if (attachmentKind === "all") return true;
      const isMedia = attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/");
      return attachmentKind === "media" ? isMedia : !isMedia;
    });
  if (attachmentKind === "all") {
    // In the past, the inline editor directly used the general attachment list of read-only messages, and did not press the input box.
    // "Media → File" visual sequence also misuses the pill of the sent message. Sorting only changes the rendering order,
    // The index still points to the original array to avoid submitting incorrect attachments after deletion.
    visibleAttachments.sort(
      ({ attachment: left }, { attachment: right }) =>
        Number(right.mime.startsWith("image/") || right.mime.startsWith("video/")) -
        Number(left.mime.startsWith("image/") || left.mime.startsWith("video/")),
    );
  }
  if (visibleAttachments.length === 0) return null;
  const previewEntries = (attachments ?? []).flatMap((attachment, index) => {
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    if (!isImage && !isVideo) return [];
    const ref = attachment.previewRef ?? attachment.ref;
    const src = thumbnailUrls.get(ref);
    if (isImage && !src) return [];
    return [
      {
        attachment,
        index,
        persistedAttachmentIndex: attachmentIndices?.[index] ?? index,
      },
    ];
  });
  const previewItems = previewEntries.map(({ attachment }) => {
    const ref = attachment.previewRef ?? attachment.ref;
    const isVideo = attachment.mime.startsWith("video/");
    return {
      alt: attachment.fileName,
      filename: attachment.fileName,
      mediaType: attachment.mime,
      src: isVideo && videoPreviewRef === ref ? videoPreview?.url : thumbnailUrls.get(ref),
      loading: isVideo && videoPreviewRef === ref && videoPreviewLoading,
      error: isVideo && videoPreviewRef === ref && videoPreviewError,
    };
  });
  const selectPreviewItem = (galleryIndex: number) => {
    const entry = previewEntries[galleryIndex];
    if (!entry) return;
    if (entry.attachment.mime.startsWith("video/")) {
      void openVideoPreview(entry.attachment, entry.persistedAttachmentIndex, galleryIndex);
      return;
    }
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
    setPreviewIndex(galleryIndex);
    setPreviewOpen(true);
  };
  const items = visibleAttachments.map(({ attachment, index }) => {
    const ref = attachment.previewRef ?? attachment.ref;
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    const isPdf = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
    const isMedia = isImage || isVideo;
    const isEditingAttachment = attachmentKind === "all";
    const isThumbnail = attachmentKind === "media" || (isEditingAttachment && isMedia);
    const fileDisplayDescriptor = resolveFileDisplayDescriptor(attachment.fileName);
    const isUnavailable = failedRefs.has(ref);
    const thumbnailUrl = thumbnailUrls.get(ref) ?? "";
    const previewItemIndex = previewEntries.findIndex((entry) => entry.index === index);
    // Pictures and videos share the media gallery of the current message; video is read when it becomes the active item for the first time.
    const canOpen =
      (isImage && !isUnavailable && previewItemIndex >= 0) ||
      (isVideo && Boolean(sessionId && readAttachment)) ||
      (isPdf && Boolean(sessionId && (readAttachment || readAttachmentRange)));
    return (
      <Attachment
        key={`${attachment.ref}-${index}`}
        variant={isThumbnail ? "grid" : "inline"}
        data-v4-user-edit-attachment-kind={
          isEditingAttachment
            ? isImage
              ? "image"
              : isVideo
                ? "video"
                : isPdf
                  ? "pdf"
                  : "file"
            : undefined
        }
        data-v4-user-input-attachment-pill={isThumbnail ? undefined : "true"}
        data-v4-user-input-media-attachment={isThumbnail ? "true" : undefined}
        className={cn(
          isThumbnail &&
            (isEditingAttachment
              ? "relative size-12 overflow-hidden rounded-lg bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-[''] hover:bg-surface-hover"
              : "relative size-20 overflow-hidden rounded-xl bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-xl after:border after:border-border after:content-[''] hover:bg-surface-hover"),
          !isThumbnail &&
            (isEditingAttachment
              ? "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
              : "rounded-full border-0 bg-surface px-3 py-1.5 hover:bg-surface-hover"),
        )}
        onRemove={onRemove ? () => onRemove(index) : undefined}
        onOpen={
          canOpen
            ? () =>
                isPdf
                  ? void openPdfPreview(attachment, attachmentIndices?.[index] ?? index)
                  : selectPreviewItem(previewItemIndex)
            : undefined
        }
        openLabel={
          canOpen
            ? isVideo
              ? previewVideoOpenLabel
              : isPdf
                ? previewPdfOpenLabel
                : previewOpenLabel
            : undefined
        }
        title={isUnavailable ? previewUnavailableLabel : undefined}
        data={{
          id: `${rowId}-${index}`,
          type: "file",
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        }}
      >
        {isThumbnail ? (
          <div className="relative size-full">
            <AttachmentPreview className="size-full rounded-none" />
          </div>
        ) : isEditingAttachment ? (
          <>
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background">
              <FileDisplayIcon
                src={fileDisplayDescriptor.fileIconSrc}
                size={16}
                className="size-4 shrink-0"
              />
            </div>
            <div className="min-w-0 max-w-40 flex-1">
              <span
                className="block truncate text-ui-base font-medium text-foreground"
                title={attachment.fileName}
              >
                {attachment.fileName}
              </span>
              <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                {getAttachmentTypeLabel(attachment.fileName, attachment.mime)}
              </span>
            </div>
          </>
        ) : (
          <FileDisplayInline
            path={attachment.fileName}
            options={{
              className: "inline-flex min-w-0 max-w-40 items-center gap-1.5",
              iconSize: 16,
              fileNameClassName: "truncate text-ui-base font-medium text-foreground",
            }}
          />
        )}
        {onRemove && isEditingAttachment ? (
          <AttachmentRemove
            placement="corner"
            size="icon"
            variant="default"
            aria-label={intl.formatMessage({ id: "chat.attachments.remove" })}
            label={intl.formatMessage({ id: "chat.attachments.remove" })}
            data-testid={testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${rowId}-${index}`)}
            className="absolute top-0.5 right-0.5 z-10 size-3.5 rounded-full p-0 text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <XIcon className="size-2.5" />
          </AttachmentRemove>
        ) : null}
      </Attachment>
    );
  });
  return (
    <>
      {directItems ? (
        items
      ) : (
        <Attachments
          variant="inline"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(rowId))}
          className="max-w-full gap-2"
        >
          {items}
        </Attachments>
      )}
      <ImagePreviewDialog
        initialIndex={previewIndex}
        items={previewItems}
        onActiveIndexChange={selectPreviewItem}
        onOpenChange={(open) => {
          if (open) {
            setPreviewOpen(true);
            return;
          }
          setPreviewOpen(false);
          closeVideoPreview();
        }}
        open={previewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfPreview}
        open={pdfPreviewRef !== null}
        loading={pdfPreviewLoading}
        error={pdfPreviewError}
        onOpenChange={(open) => {
          if (!open) closePdfPreview();
        }}
      />
    </>
  );
});

const UserInputRowView = memo(function UserInputRowView({
  row,
  context,
  onEdit,
  editWorkspaceRewindAvailability,
  status,
}: {
  row: UserInputRow;
  context: ConversationRowRenderContext;
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  status?: string;
}) {
  const { intl } = useZCodeIntl();
  // Engine endnote collapse: the text only reaches epilogueStart,
  // The engine text after that is folded into the disclosure at the bottom of the bubble. The prompt word context analysis also only looks at the main text - there are no user references in the endnotes.
  const { body: bodyText, epilogue } = splitUserInputEpilogue(row.text, row.epilogueStart);
  const parsedPrompt = useMemo(
    () =>
      parseComposerPromptContexts(bodyText, {
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      }),
    [bodyText, context.workspaceIdentity, context.workspacePath],
  );
  // It is only used to strip the share URL tail block from the visible body of historical messages.
  // This block is no longer produced (see the promptText annotation of ConversationComposer); parsing is retained here for
  // Messages sent between the wiring repair and this deletion will not display bare markup as the text.
  const parsedShareContext = useMemo(
    () => parseConversationShareContext(parsedPrompt.visibleContent),
    [parsedPrompt.visibleContent],
  );
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState(row.text);
  const [editAttachments, setEditAttachments] = useState<AttachmentRef[]>(() => [
    ...(row.attachments ?? []),
  ]);
  // After deleting attachments in editing mode, the persistent FilePart list still retains all attachments; the serial number array replaces the visible list with
  // Map back to the original index to avoid incorrect blocking of video previews and other reading instructions based on attachmentIndex.
  const [editAttachmentIndices, setEditAttachmentIndices] = useState<number[]>(() =>
    (row.attachments ?? []).map((_, index) => index),
  );
  const [editPromptContexts, setEditPromptContexts] = useState(() => parsedPrompt);
  const [conflictPreview, setConflictPreview] =
    useState<V4ConversationFileRewindPreviewResult | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const editContextCount = countComposerPromptContexts(editPromptContexts);
  const canSubmit = draft.trim().length > 0 || editAttachments.length > 0 || editContextCount > 0;
  const submitLabel = intl.formatMessage({ id: "chat.send" });
  const cancelLabel = intl.formatMessage({ id: "common.cancel" });
  const rewindWorkspaceLabel = intl.formatMessage({
    id: "chat.edit.resetConversationAndFiles",
  });
  const rewindWorkspaceTooltipTitle = intl.formatMessage({
    id: "chat.edit.resetConversationAndFiles.tooltip",
  });
  const rewindWorkspaceTooltipDescription =
    editWorkspaceRewindAvailability?.reason === "available"
      ? undefined
      : intl.formatMessage({
          id: `chat.edit.resetConversationAndFiles.${editWorkspaceRewindAvailability?.reason ?? "noFiles"}`,
        });
  const visibleText = parsedShareContext.visibleContent;
  const codeCommentContexts = parsedPrompt.codeComments;
  const webElementContexts = parsedPrompt.webElements;
  const pptxElementReferences = parsedPrompt.pptxElements;
  const conversationSelections = parsedPrompt.conversationSelections;
  const hasAttachments = (row.attachments?.length ?? 0) > 0;
  const hasMediaAttachments =
    row.attachments?.some(
      (attachment) => attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasFileAttachments =
    row.attachments?.some(
      (attachment) =>
        !attachment.mime.startsWith("image/") && !attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasVisibleText = visibleText.trim().length > 0;
  // The entire nudge wheel is engine text: the text is empty but the bubbles still need to be drawn, and only the one inside is revealed.
  const hasBubble = hasVisibleText || epilogue !== undefined;
  const hasContextReferences =
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    conversationSelections.length > 0;
  const hasAttachmentArea = hasAttachments || hasContextReferences;
  const hasAttachmentPills = hasFileAttachments || hasContextReferences;
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath: context.workspacePath,
    workspaceIdentity: context.workspaceIdentity,
    remoteSessionId: context.workspaceRemoteSessionId,
    onOpenCodeViewer: context.onOpenCodeViewer,
  });

  useEffect(() => {
    if (!editing) {
      setDraft(parsedShareContext.visibleContent);
      setEditAttachments([...(row.attachments ?? [])]);
      setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
      setEditPromptContexts(parsedPrompt);
      return;
    }
    const focusEditor = () => inputApiRef.current?.focus();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(focusEditor);
      return;
    }
    focusEditor();
  }, [editing, parsedPrompt, row.attachments]);

  useEffect(() => {
    if (!onEdit) {
      setEditing(false);
      setSubmitting(false);
    }
  }, [onEdit]);

  const handleOpenEdit = useCallback(() => {
    // During v4 migration, the user query editor was mistakenly connected to "directly read the main composer submission".
    // Clicking when the main composer is empty will only warn. The old inline editing state is restored here.
    setDraft(parsedShareContext.visibleContent);
    setEditAttachments([...(row.attachments ?? [])]);
    setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
    setEditPromptContexts(parsedPrompt);
    setEditing(true);
  }, [parsedPrompt, parsedShareContext, row.attachments]);

  const handleCancelEdit = useCallback(() => {
    setDraft(parsedShareContext.visibleContent);
    setEditAttachments([...(row.attachments ?? [])]);
    setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
    setEditPromptContexts(parsedPrompt);
    setEditing(false);
  }, [parsedPrompt, parsedShareContext, row.attachments]);

  const handleRemoveEditAttachment = useCallback((index: number) => {
    setEditAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setEditAttachmentIndices((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const handleSubmitEdit = useCallback(
    async (nextText: string, workspaceMode: "preserve" | "rewind" = "preserve") => {
      if (!onEdit) return;
      if (!nextText.trim() && editAttachments.length === 0 && editContextCount === 0) return;
      setSubmitting(true);
      try {
        const result = await onEdit(
          { rowId: row.rowId, entityId: row.entityId! },
          // No longer write back the share URL tail block: it does not have any consumers and can be easily cleared when editing historical messages.
          serializeComposerPromptContexts(nextText, editPromptContexts),
          // Omitting the empty array will cause the CLI to restore the canonical original attachment according to the default semantics of attachments.
          // So edit must always commit the current complete list, explicit [] can express "remove all".
          editAttachments,
          workspaceMode,
        );
        if (
          typeof result === "object" &&
          result !== null &&
          result.result?.type === "editUserQuery" &&
          result.result.disposition === "blocked" &&
          result.result.preview
        ) {
          setConflictPreview(result.result.preview);
          setConflictOpen(true);
          return;
        }
        if (result !== false) {
          setEditing(false);
          setConflictOpen(false);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [editAttachments, editContextCount, editPromptContexts, onEdit, row.entityId, row.rowId],
  );
  const rewindWorkspaceDisabled = submitting || editWorkspaceRewindAvailability?.enabled !== true;
  const rewindWorkspaceButton = (
    <Button
      type="button"
      variant="outline"
      size="icon-md"
      disabled={rewindWorkspaceDisabled}
      data-testid={testId(TID_V4_EDIT_REWIND_WORKSPACE, String(row.rowId))}
      aria-label={rewindWorkspaceLabel}
      onClick={() => {
        void handleSubmitEdit(draft, "rewind");
      }}
    >
      <FileClockIcon className="size-4" />
    </Button>
  );

  if (editing) {
    return (
      <RowShell rowId={row.rowId} className="flex flex-col items-end">
        <ChatPromptEditor
          workspacePath={context.workspacePath}
          taskId={context.sessionId ?? null}
          initialValue={parsedPrompt.visibleContent}
          submitting={submitting}
          submitDisabled={!canSubmit || submitting}
          allowSubmitWhenEmpty={editAttachments.length > 0 || editContextCount > 0}
          submitLabel={submitLabel}
          cancelLabel={cancelLabel}
          showMentionButton
          showSlashButton
          enableWorkspaceFileDrop
          topContent={
            editAttachments.length > 0 || editContextCount > 0 ? (
              <div className="flex max-w-full flex-col items-start gap-2">
                {editAttachments.length > 0 ? (
                  <UserInputAttachmentList
                    attachments={editAttachments}
                    attachmentIndices={editAttachmentIndices}
                    entityId={row.entityId}
                    rowId={row.rowId}
                    onRemove={handleRemoveEditAttachment}
                    sessionId={context.sessionId ?? undefined}
                    readAttachment={context.readAttachment}
                    readAttachmentRange={context.readAttachmentRange}
                  />
                ) : null}
                {editContextCount > 0 ? (
                  <div
                    className="flex max-w-full flex-wrap items-center gap-2"
                    data-v4-user-edit-context-attachments-row="true"
                  >
                    <CodeCommentAttachmentChip
                      comments={editPromptContexts.codeComments}
                      onRemove={(comment) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          codeComments: current.codeComments.filter((item) => item !== comment),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          codeComments: [],
                        }))
                      }
                    />
                    <WebElementContextAttachmentChip
                      contexts={editPromptContexts.webElements}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          webElements: current.webElements.filter((item) => item.id !== id),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          webElements: [],
                        }))
                      }
                    />
                    <PptxElementReferenceChip
                      references={editPromptContexts.pptxElements}
                      onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          pptxElements: current.pptxElements.filter((item) => item.id !== id),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          pptxElements: [],
                        }))
                      }
                    />
                    <ConversationSelectionReferenceChip
                      references={editPromptContexts.conversationSelections}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          conversationSelections: current.conversationSelections.filter(
                            (item) => !("id" in item) || item.id !== id,
                          ),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          conversationSelections: [],
                        }))
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : null
          }
          inputApiRef={inputApiRef}
          inputTestId={testId(TID_V4_EDIT_INPUT, String(row.rowId))}
          submitTestId={testId(TID_V4_EDIT_SUBMIT, String(row.rowId))}
          cancelTestId={testId(TID_V4_EDIT_CANCEL, String(row.rowId))}
          betweenCancelAndSubmitAction={
            <ControlHintTooltip
              title={rewindWorkspaceTooltipTitle}
              description={rewindWorkspaceTooltipDescription}
            >
              {rewindWorkspaceDisabled ? (
                // Button disabled will apply pointer-events-none, and TooltipTrigger will fall directly on
                // Cannot receive hover when the button is on. In the disabled state, the outer span is used to handle the hover, and the actual button remains disabled.
                <span className="inline-flex" data-disabled-tooltip-trigger="true">
                  {rewindWorkspaceButton}
                </span>
              ) : (
                rewindWorkspaceButton
              )}
            </ControlHintTooltip>
          }
          className="w-full max-w-xl"
          shellClassName="min-h-32"
          onChange={setDraft}
          onSubmit={(nextText) => {
            void handleSubmitEdit(nextText, "preserve");
          }}
          onCancel={handleCancelEdit}
        />
        <ConversationFileRewindDialog
          variant="editConflict"
          open={conflictOpen}
          onOpenChange={setConflictOpen}
          preview={conflictPreview}
          previewLoading={false}
          applying={submitting}
          error={null}
          onApply={() => {}}
          onConversationOnly={() => {
            void handleSubmitEdit(draft, "preserve");
          }}
        />
      </RowShell>
    );
  }

  return (
    <RowShell rowId={row.rowId} className="group/user-row flex flex-col items-end">
      {hasAttachmentArea ? (
        <div
          data-v4-user-input-attachments="true"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(row.rowId))}
          className="mb-2 flex max-w-xl flex-col items-end gap-2"
        >
          {hasMediaAttachments ? (
            <div
              data-v4-user-input-media-attachments="true"
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              <UserInputAttachmentList
                attachments={row.attachments}
                entityId={row.entityId}
                attachmentKind="media"
                directItems
                rowId={row.rowId}
                sessionId={context.sessionId ?? undefined}
                readAttachment={context.readAttachment}
                readAttachmentRange={context.readAttachmentRange}
              />
            </div>
          ) : null}
          {hasAttachmentPills ? (
            <div
              data-v4-user-input-attachment-pills="true"
              // Non-media files and contextual references must share this layer in order to
              // Keep the order of "File→Comments→Webpage→PPT→Conversation Quotes" and uniform right alignment.
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              {hasFileAttachments ? (
                <UserInputAttachmentList
                  attachments={row.attachments}
                  entityId={row.entityId}
                  attachmentKind="file"
                  directItems
                  rowId={row.rowId}
                  sessionId={context.sessionId ?? undefined}
                  readAttachment={context.readAttachment}
                  readAttachmentRange={context.readAttachmentRange}
                />
              ) : null}
              <CodeCommentAttachmentChip comments={codeCommentContexts} contentAlign="end" />
              <WebElementContextAttachmentChip contexts={webElementContexts} contentAlign="end" />
              <PptxElementReferenceChip
                references={pptxElementReferences}
                contentAlign="end"
                onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
              />
              <ConversationSelectionReferenceChip
                references={conversationSelections}
                contentAlign="end"
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {hasBubble ? (
        // Attachments and context references belong only to message lines, not bubbles; otherwise attachment-only messages would leave empty bubbles.
        // The same row will be rendered in the main session and Subagent sidebar, and the fixed width will ignore the actual host width.
        // The bubble retains the automatic width of the flex item; when the host is at least 624px, it is capped with 36rem and retains a 48px margin.
        <div
          data-v4-user-input-bubble="true"
          className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl"
        >
          {hasVisibleText ? (
            <ConversationUserInputBody contentText={visibleText} rowId={row.rowId}>
              <ConversationUserInputContent
                text={visibleText}
                attachments={row.attachments}
                contextAttachmentCount={countComposerPromptContexts(parsedPrompt)}
              />
            </ConversationUserInputBody>
          ) : null}
          {epilogue === undefined ? null : <ConversationUserInputEpilogue text={epilogue} />}
        </div>
      ) : null}
      {status ? (
        <div
          data-v4-user-input-status="true"
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          aria-live="polite"
        >
          {status}
        </div>
      ) : null}
      {/* Phone remote control has no hover, and the v4 migration dropped the always-visible branch of
          the legacy UserMessage, which made the copy and edit entry points undiscoverable; they are
          shown directly on remote control, while the desktop keeps reducing noise via hover/focus.
          */}
      <MessageActions
        className={cn(
          "mt-1",
          "opacity-0 transition-opacity group-hover/user-row:opacity-100 focus-within:opacity-100",
        )}
      >
        <CopyRowAction
          text={row.text}
          rowId={row.rowId}
          label={intl.formatMessage({ id: "chat.message.copy" })}
        />
        {onEdit && row.entityId ? (
          <MessageAction
            label={intl.formatMessage({ id: "chat.message.edit" })}
            tooltip={intl.formatMessage({ id: "chat.message.edit" })}
            data-testid={testId(TID_V4_EDIT, String(row.rowId))}
            onClick={handleOpenEdit}
          >
            <PencilIcon className="size-3.5" />
          </MessageAction>
        ) : null}
      </MessageActions>
    </RowShell>
  );
});

export const ConversationAssistantTextActions = memo(function ConversationAssistantTextActions({
  rowId,
  entityId,
  text,
  createdAt,
  feedback = null,
  hookInvocations,
  sessionId,
  turnId,
  onFork,
  onFeedbackChange,
  className,
}: {
  rowId: number;
  entityId?: string;
  text: string;
  createdAt: number;
  feedback?: AssistantMessageFeedback | null;
  hookInvocations?: readonly HookInvocationRow[];
  sessionId?: string | null;
  turnId?: string;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [localFeedback, setLocalFeedback] = useState<AssistantMessageFeedback | null>(feedback);
  const copyLabel = intl.formatMessage({ id: "chat.message.copy" });
  const likeLabel = intl.formatMessage({
    id: localFeedback === "like" ? "chat.message.liked" : "chat.message.like",
  });
  const dislikeLabel = intl.formatMessage({
    id: localFeedback === "dislike" ? "chat.message.disliked" : "chat.message.dislike",
  });
  const forkLabel = intl.formatMessage({ id: "chat.message.fork" });
  const timeLabel = formatMessageTimeLabel(createdAt, "en-US", intl);
  const resolveTooltip = (label: string): string | undefined => label;

  useEffect(() => {
    setLocalFeedback(feedback);
  }, [feedback]);

  const handleFeedback = useCallback(
    (nextFeedback: AssistantMessageFeedback) => {
      const previousFeedback = localFeedback;
      const resolvedFeedback = previousFeedback === nextFeedback ? null : nextFeedback;
      setLocalFeedback(resolvedFeedback);
      logger.info("[ConversationRowView] user gave feedback on assistant message", {
        messageId: entityId ?? null,
        reaction: resolvedFeedback ?? "none",
      });
      if (entityId) {
        void Promise.resolve(onFeedbackChange?.({ rowId, entityId }, resolvedFeedback)).then(
          (result) => {
            if (result === false) setLocalFeedback(previousFeedback);
          },
          (error: unknown) => {
            setLocalFeedback(previousFeedback);
            // The first version of V4 only changes the renderer local state. If the command fails, non-existent feedback will be displayed.
            // In case of failure, you must roll back to the pre-click projection value and wait for subsequent authoritative rows to be corrected.
            logger.warn("[ConversationRowView] failed to persist assistant feedback", {
              error: error instanceof Error ? error.message : String(error),
              messageId: entityId,
            });
          },
        );
      }
      if (platform && entityId) {
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "assistant_message_feedback",
            eventRegion: "chat",
            eventType: "ck",
            eventExtraDetail: { reaction: resolvedFeedback ?? "none" },
            ...(sessionId ? { talkId: sessionId } : {}),
            messageId: entityId,
          },
          "ConversationRowView",
        );
      }
    },
    [entityId, localFeedback, onFeedbackChange, platform, rowId, sessionId],
  );
  const handleFork = useCallback(() => {
    if (entityId) {
      runUserAction({
        input: { featureId: "conversation.history.branch", action: "fork", trigger: "button" },
        operation: () => onFork?.({ rowId, entityId }),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "fork",
      });
    }
  }, [entityId, onFork, rowId]);
  return (
    <MessageActions className={cn(className)}>
      <CopyRowAction
        text={text}
        rowId={rowId}
        label={copyLabel}
        tooltip={resolveTooltip(copyLabel)}
      />
      {entityId && onFeedbackChange ? (
        <>
          <MessageAction
            aria-label={likeLabel}
            aria-pressed={localFeedback === "like"}
            label={likeLabel}
            tooltip={resolveTooltip(likeLabel)}
            data-testid={testId(TID_V4_FEEDBACK_LIKE, String(rowId))}
            className={localFeedback === "like" ? "!bg-success/10" : undefined}
            onClick={() => handleFeedback("like")}
          >
            <span
              className={cn(
                "relative inline-flex",
                localFeedback === "like" && "zcode-reaction-burst",
              )}
            >
              <ThumbsUpIcon className="size-3.5" />
            </span>
          </MessageAction>
          <MessageAction
            aria-label={dislikeLabel}
            aria-pressed={localFeedback === "dislike"}
            label={dislikeLabel}
            tooltip={resolveTooltip(dislikeLabel)}
            data-testid={testId(TID_V4_FEEDBACK_DISLIKE, String(rowId))}
            className={localFeedback === "dislike" ? "!bg-warning/10" : undefined}
            onClick={() => handleFeedback("dislike")}
          >
            <span
              className={cn(
                "relative inline-flex",
                localFeedback === "dislike" && "zcode-reaction-burst",
              )}
            >
              <ThumbsDownIcon className="size-3.5" />
            </span>
          </MessageAction>
        </>
      ) : null}
      {onFork && entityId ? (
        <MessageAction
          aria-label={forkLabel}
          label={forkLabel}
          tooltip={resolveTooltip(forkLabel)}
          data-testid={testId(TID_V4_FORK, String(rowId))}
          onClick={handleFork}
        >
          <TrendingUpDownIcon className="size-3.5" />
        </MessageAction>
      ) : null}
      {turnId && hookInvocations ? (
        <ConversationHookDetailsAction rows={hookInvocations} turnId={turnId} />
      ) : null}
      {/* After the legacy conversation surface was removed, the V4 action bar lost the message creation
          time; the time is a read-only derived display of row.createdAt, so no new renderer state
          is introduced.
          */}
      {timeLabel ? (
        <span className="select-none text-ui-sm text-foreground-subtlest">{timeLabel}</span>
      ) : null}
    </MessageActions>
  );
});

const AssistantTextRowView = memo(function AssistantTextRowView({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  hideActions,
  deferActions,
  copyText,
  previewCards,
  previewCardsAutoOpenKey,
  codeCommentCards,
  codeCommentProjectionEnabled,
}: {
  row: AssistantTextRow;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  hideActions?: boolean;
  deferActions?: boolean;
  copyText?: string;
  previewCards?: AssistantPreviewCard[];
  previewCardsAutoOpenKey?: string;
  codeCommentCards?: AssistantCodeCommentCard[];
  codeCommentProjectionEnabled?: boolean;
}) {
  const streaming = row.state === "streaming";
  const isOfficeMode = useIsOfficeMode();
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const projectsCodeComments = codeCommentCardsEnabled && codeCommentProjectionEnabled === true;
  const visibleText = useMemo(
    () =>
      projectsCodeComments
        ? projectAssistantCodeComments(row.text, { streaming }).visibleText
        : row.text,
    [projectsCodeComments, row.text, streaming],
  );
  const visiblePreviewCards = previewCards && previewCards.length > 0 ? previewCards : null;
  return (
    <RowShell rowId={row.rowId} className="group/assistant-row">
      {/* assistant text goes through streamdown (MessageResponse), which renders markdown and code
          blocks for real; streaming mode tolerates unclosed markdown.
          */}
      {/* MessageResponse only consumes the props it declares and does not pass data-* through to the
          real DOM, so although the assistant body is marked selectable in the JSX, the text
          selection logic can never find that region. The selectable semantics have to sit on a
          stable DOM wrapper, shared by the completed state and streaming.
          */}
      <div data-conversation-selectable="true" className="w-full text-ui-base">
        <MessageResponse
          renderZCodeFileCitations
          streaming={streaming}
          workspacePath={context.workspacePath}
          workspaceIdentity={context.workspaceIdentity}
          workspaceRemoteSessionId={context.workspaceRemoteSessionId}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          forceCodeWrap={isOfficeMode}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenExternalUrl={context.onOpenBrowserUrl}
          sessionId={context.sessionId ?? undefined}
          readAttachment={context.readAttachment}
        >
          {visibleText}
        </MessageResponse>
      </div>
      {codeCommentCardsEnabled && codeCommentCards && codeCommentCards.length > 0 ? (
        <div className="mt-3">
          <AssistantCodeCommentCards
            cards={codeCommentCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenCodeViewer={context.onOpenCodeViewer}
          />
        </div>
      ) : null}
      {visiblePreviewCards ? (
        <div className="mt-3">
          <AssistantPreviewCards
            cards={visiblePreviewCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            autoOpenPptxKey={previewCardsAutoOpenKey}
            onAutoOpenPptx={context.onAutoOpenAssistantPptx}
          />
        </div>
      ) : null}
      {/* The completed-state action row appears on hover (aligned with the legacy MessageActions):
          copy + fork (icon ghost). One turn is one reply to the user: actions appear only on the
          turn's final segment (hideActions is decided by TurnGroup), and the copy content = all
          text segments of the whole turn merged (copyText overrides).
          */}
      {row.state === "complete" && !hideActions && !deferActions ? (
        <ConversationAssistantTextActions
          rowId={row.rowId}
          entityId={row.entityId}
          text={copyText ?? row.text}
          createdAt={row.createdAt}
          feedback={readAssistantFeedback(row)}
          sessionId={context.sessionId}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          className={cn(
            "mt-1",
            "opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100",
          )}
        />
      ) : null}
    </RowShell>
  );
});

const ReasoningRowView = memo(function ReasoningRowView({
  row,
  contentVariant,
}: {
  row: ReasoningRow;
  contentVariant?: "default" | "nested";
}) {
  const streaming = row.state === "streaming";
  // Appearance Alignment Old ThoughtBlock (legacy chatMessageParts): ai-elements Reasoning
  // Collapse components. Reason for interactive adjustment: The default expansion of streaming reasoning will continue to squeeze the tool and text space;
  // Now streaming/complete are collapsed by default, leaving only the running copy, which users can manually expand.
  // autoCollapseKey still ensures that state boundaries do not overwrite user interactions that have already occurred.
  const durationSeconds =
    row.durationMs !== undefined ? Math.max(1, Math.ceil(row.durationMs / 1000)) : undefined;
  if (streaming && row.text.length === 0) {
    return null;
  }
  return (
    <RowShell rowId={row.rowId}>
      <Reasoning
        className="w-full"
        isStreaming={streaming}
        autoCollapseKey={streaming ? null : row.state}
        {...(durationSeconds !== undefined ? { duration: durationSeconds } : {})}
      >
        {/* The attachment refactor merge accidentally dropped the streamingText wiring, leaving the summary component in place but always handed an empty string. */}
        <ReasoningTrigger streamingText={row.text} />
        <div data-conversation-selectable="true">
          <ReasoningContent variant={contentVariant}>{row.text}</ReasoningContent>
        </div>
      </Reasoning>
    </RowShell>
  );
});

const TurnHeaderRowView = memo(function TurnHeaderRowView({ row }: { row: TurnHeaderRow }) {
  return (
    <RowShell
      rowId={row.rowId}
      className="border-b border-[var(--color-border)] py-1 text-ui-sm text-[var(--color-foreground-subtle)]"
    >
      turn · {row.origin} · {row.state}
    </RowShell>
  );
});

/** The divider icon (aligned with the legacy synthetic-timeline dividers: size-3.5 subtle). */
const MARKER_ARCHIVE_ICON = (
  <ArchiveIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_FORK_ICON = (
  <GitBranchIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_GOAL_ICON = (
  <GoalIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_MODEL_ICON = (
  <ArrowRightLeftIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);

/**
 * The shell for system-marker dividers: thin rules on both sides + a centered “icon + copy” pill,
 * visually aligned with the legacy ChatMessage synthetic-timeline dividers (the same one for fork /
 * compaction / goal). While running (compaction / verification in progress) the icon is hidden and
 * the copy uses the animated-gradient-text shimmer (as in the legacy version).
 */
function MarkerDividerRow({
  rowId,
  markerType,
  markerStatus,
  markerOrigin,
  markerSourceCommandId,
  icon,
  label,
  running = false,
  onClick,
}: {
  rowId: number;
  markerType: TimelineMarkerRow["marker"]["type"];
  markerStatus: string;
  markerOrigin?: string;
  markerSourceCommandId?: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  running?: boolean;
  /**
   * Passing one makes the whole row clickable (fork → jump to the parent conversation); without one
   * it is a static divider.
   */
  onClick?: () => void;
}) {
  const clickable = Boolean(onClick);
  const rowClassName =
    "flex w-full items-center gap-3 px-4 py-2 text-ui-base text-[var(--color-foreground-subtle)]";
  const inner = (
    <>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
      <span className="inline-flex min-w-0 shrink items-center justify-center gap-1.5 text-center leading-5">
        {running ? null : icon}
        <span
          className={`min-w-0 break-words${running ? " animated-gradient-text font-medium" : ""}${clickable ? " underline-offset-4 group-hover/marker:underline" : ""}`}
        >
          {label}
        </span>
      </span>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
    </>
  );
  if (onClick) {
    // The entire row of <button> (aligned with the old fork divider): hover becomes brighter + the copy is underlined to indicate clickability.
    return (
      <button
        type="button"
        data-row-id={rowId}
        data-row-kind="timelineMarker"
        data-marker-type={markerType}
        data-status={markerStatus}
        data-origin={markerOrigin}
        data-source-command-id={markerSourceCommandId}
        data-testid={testId(TID_V4_ROW, String(rowId))}
        onClick={onClick}
        className={`group/marker ${rowClassName} text-left transition-colors hover:text-[var(--color-foreground)]`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      data-row-id={rowId}
      data-row-kind="timelineMarker"
      data-marker-type={markerType}
      data-status={markerStatus}
      data-origin={markerOrigin}
      data-source-command-id={markerSourceCommandId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={rowClassName}
    >
      {inner}
    </div>
  );
}

/**
 * timelineMarker row rendering: compact / forkNotice / goalVerify / modelChange are drawn as
 * dividers. Making modelChange visible is a decision (only a turn that was actually sent after the
 * switch drops a divider, including a model-only continuation turn); goalSet/forkCreated were
 * already retired at the projection layer (their invisible rows are zeroed out),
 * retryNotice·checkpointRestored have no UI, and the default branch renders nothing as a fallback.
 */
const TimelineMarkerRowView = memo(function TimelineMarkerRowView({
  row,
  context,
}: {
  row: TimelineMarkerRow;
  context: ConversationRowRenderContext;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const marker = row.marker;
  const modelSelectionView = context.modelSelectionView ?? null;
  const view = useMemo((): {
    icon: React.ReactNode;
    label: React.ReactNode;
    running: boolean;
  } | null => {
    switch (marker.type) {
      case "compact": {
        const running = marker.status === "running";
        const automaticOptimization = isOfficeMode && marker.origin === "auto";
        const scope = automaticOptimization ? "chat.contextOptimization" : "chat.contextCompaction";
        const statusMessage =
          marker.status === "running"
            ? "started"
            : marker.status === "noop"
              ? "skipped"
              : marker.status === "cancelled"
                ? "interrupted"
                : marker.status === "failed"
                  ? "failed"
                  : marker.origin === "auto" && !automaticOptimization
                    ? "completedAuto"
                    : "completed";
        return {
          icon: MARKER_ARCHIVE_ICON,
          label: intl.formatMessage({ id: `${scope}.${statusMessage}` }),
          running,
        };
      }
      case "forkNotice":
        return {
          icon: MARKER_FORK_ICON,
          label: intl.formatMessage({ id: "chat.message.fork.derivedFrom" }),
          running: false,
        };
      case "modelChange": {
        // The marker already carries the complete provider/model tuple, but the old rendering only reads the model.
        // And there is no subscription to the provider snapshot, resulting in no difference in the model with the same name, and the name is not refreshed after the directory is hydrated.
        // This preserves the provider ID fallback and lets existing markers be updated with the catalog.
        const fromProvider = resolveProviderLabel(marker.fromProvider, modelSelectionView);
        const toProvider = resolveProviderLabel(marker.toProvider, modelSelectionView);
        const to = formatModelChangeLabel(marker.toProvider, toProvider, marker.toModel, intl);
        if (marker.fromProvider === undefined || marker.fromModel === undefined) {
          return {
            // source-less represents the model fact used for the first time, not a model switch, so no switch arrows are shown.
            icon: null,
            label: intl.formatMessage({ id: "chat.modelChange.using" }, { model: to }),
            running: false,
          };
        }
        return {
          icon: MARKER_MODEL_ICON,
          label: intl.formatMessage(
            { id: "chat.modelChange.switched" },
            {
              from: formatModelChangeLabel(
                marker.fromProvider,
                fromProvider,
                marker.fromModel,
                intl,
              ),
              to,
            },
          ),
          running: false,
        };
      }
      case "goalVerify": {
        const running = marker.outcome === "running";
        // pass→Complete; notSatisfied/failed→Unfinished (the old version of failed_closed will still be classified as "unfinished").
        const statusId =
          marker.outcome === "running"
            ? "chat.goalVerification.checking"
            : marker.outcome === "pass"
              ? "chat.goalVerification.complete"
              : "chat.goalVerification.incomplete";
        return {
          icon: MARKER_GOAL_ICON,
          running,
          // innerText is in the form of "The 1st iteration·Goal verification is in progress" and is aligned with the goal-timeline standby e2e assertion.
          label: (
            <>
              <span>
                {intl.formatMessage(
                  { id: "chat.summaryPanel.goalIterationValue" },
                  { count: String(marker.iteration) },
                )}
              </span>
              <span aria-hidden="true"> · </span>
              {intl.formatMessage({ id: statusId })}
            </>
          ),
        };
      }
      default:
        return null;
    }
  }, [intl, isOfficeMode, marker, modelSelectionView]);

  // Fork jumps to the parent session (Tier 1): It can only be clicked when forkNotice and the host provides onNavigateToRow.
  // Switch to marker.parentSessionId (rowId is reserved for Tier 2 precision scrolling, currently always 0).
  const onNavigate = context.onNavigateToRow;
  const handleClick = useMemo(() => {
    if (marker.type !== "forkNotice" || !onNavigate) {
      return undefined;
    }
    return () => onNavigate(marker.parentSessionId, marker.parentRowId);
  }, [marker, onNavigate]);

  if (!view) {
    return null;
  }
  return (
    <MarkerDividerRow
      rowId={row.rowId}
      markerType={marker.type}
      markerStatus={
        marker.type === "compact"
          ? marker.status
          : marker.type === "goalVerify"
            ? marker.outcome
            : marker.type === "forkNotice"
              ? "created"
              : "applied"
      }
      markerOrigin={marker.type === "compact" ? marker.origin : undefined}
      markerSourceCommandId={row.sourceCommandId}
      icon={view.icon}
      label={view.label}
      running={view.running}
      onClick={handleClick}
    />
  );
});

const ToolCallRowView = memo(function ToolCallRowView({
  row,
  context,
}: {
  row: ToolCallRow;
  context: ConversationRowRenderContext;
}) {
  // toolCall line callback ToolCallBlocks (execute/read/edit/... renderer press
  // tool identity shunt). Adapt memo by row reference: row.delta/upserted Rebuild with new object.
  const toolCallNode = useMemo(() => toolCallRowToLegacyNode(row), [row]);
  // Gating control of workflow run details entrance: run identity goes through workflowRuns projection (toolCallId in schema is
  // "Tool card → associated key of details page"), do not read from the tool output - the output of line v4 only has one sentence of prose.
  // The summary of the hit also determines the form of the card: if it has a run, it means a compact clickable card, if it doesn't, it means an expandable card.
  const workflowRun =
    context.workflowRunByToolCallId?.get(row.toolCallId) ??
    // ResumeWorkflowRun lines are joined by runId: display payload with runId (≡ backgroundTaskId), and projection
    // The run.toolCallId across resume lines is used along with the original CreateWorkflow - the resume line presses toolCallId forever
    // Not found. After hitting onOpenWorkflowRun, the narrowing takes the same path, tab identity, runId key, idempotent.
    (row.display?.kind === "resume_workflow_run"
      ? context.workflowRunByRunId?.get(row.display.runId)
      : undefined);
  // Reason: The activated tool card and the end of the wheel summary repeatedly draw the same real-time progress; the upper part is changed to a normal summary entry.
  // Only the initiating lines that are successfully associated are replaced. Other tools such as compilation diagnosis and Resume still use the original rendering.
  if (
    workflowRun &&
    context.workflowRunByToolCallId?.has(row.toolCallId) &&
    row.status !== "error"
  ) {
    const workflowName = readWorkflowName(row.input);
    const sessionId = context.sessionId;
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={workflowRun}
          amend={isAmendWorkflowToolCall(row)}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                    ...(workflowName === undefined ? {} : { workflowName }),
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // Revisions that take effect locally: only change the upper limit of concurrency, and call this time when run is in flight
  // Without compilation or new run, the result is only one sentence. The criteria are all based on the fields that are already online - the shape of the input parameters, **no** display,
  // Successful and non-error; the structured output of the tool is no more than v4, and the three create_workflow display schema are all frozen field sets
  // `.strict()`, one more key will cause the old end to discard the entire tool result, so this path does not add any protocol fields.
  // The one that returns the true revision (the run has been settled) does not hold both criteria: it has display, and it also casts a toolCallId
  // For a run that can be connected, the branch above will pick it up first.
  const retune = isAmendWorkflowToolCall(row) ? readWorkflowRetuneCall(row.input) : undefined;
  if (
    retune !== undefined &&
    row.status === "success" &&
    (row.output?.display ?? row.display) === undefined &&
    !context.workflowRunByToolCallId?.has(row.toolCallId)
  ) {
    const sessionId = context.sessionId;
    // The projection of that run is adjusted: just for two things - the local ceiling (worded so it doesn't pronounce a number greater than the ceiling) and
    // Open the initiating line ID of the run in the request. It doesn't go into `workflowRun` above: that variable answers "Is this line
    // "The initiating line of a run", and this line is not.
    const retuned = context.workflowRunByRunId?.get(retune.runId);
    const ceiling =
      retuned?.run === undefined ? undefined : workflowRunSettingsCeiling(retuned.run);
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowRetuneRow
          requested={retune.requested}
          runId={retune.runId}
          {...(ceiling === undefined ? {} : { ceiling })}
          {...(context.onOpenWorkflowRun && sessionId
            ? {
                onOpen: () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, retuned),
                    runId: retune.runId,
                  }),
              }
            : {})}
        />
      </RowShell>
    );
  }
  // Tool row removes vertical padding (aligned z-code-2 without per-tool padding); continuous tool spacing is given by
  // The gap-4 group containers of ConversationAssistantWorkItems are unified.
  return (
    <RowShell rowId={row.rowId} className="py-0">
      <div data-conversation-selectable="true">
        <ToolCallBlock
          toolCallNode={toolCallNode}
          workspacePath={context.workspacePath}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          showTodoToolCalls={context.messageStreamShowTodos === true}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenBrowserUrl={context.onOpenBrowserUrl}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
          onOpenPlanDetail={
            context.onOpenPlanDetail && context.sessionId
              ? (request) =>
                  context.onOpenPlanDetail?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                  })
              : undefined
          }
          onOpenWorkflowRun={
            context.onOpenWorkflowRun && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowRun?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    // The associated key for opening a request is the initiating row (CreateWorkflow) id, not the id of the middle row——
                    // The two are different when the resume line is clicked. Use it to find causalityGraph/script on the details page.
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onOpenWorkflowActor={
            context.onOpenWorkflowActor && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowActor?.({ ...request, parentSessionId: context.sessionId! })
              : undefined
          }
          // script pill → script transcript: associated key same as onOpenWorkflowRun(initiating row id + runId).
          onOpenWorkflowWorkspace={
            context.onOpenWorkflowWorkspace && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowWorkspace?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onResumeWorkflowRun={
            context.onResumeWorkflowRun && workflowRun?.resumable
              ? (request) => context.onResumeWorkflowRun?.(workflowRun.runId, request.workflowName)
              : undefined
          }
          // Product Pill → Product tab: The same opening path as the chips in the notification line (without a version number, the latest version will be opened).
          onOpenWorkflowArtifact={
            context.onOpenWorkflowArtifact && context.sessionId && workflowRun
              ? (artifactId) => {
                  // The product summary of the live projection comes with the latest version of `contentType` (the host can directly open the html product into
                  // Browser tab); `sourcePath` The summary is deliberately not included, and the host will check the journal by itself in its absence.
                  const artifact = workflowRun.run?.artifacts?.find(
                    (candidate) => candidate.id === artifactId,
                  );
                  context.onOpenWorkflowArtifact?.({
                    parentSessionId: context.sessionId!,
                    runId: workflowRun.runId,
                    artifactId,
                    ...(artifact?.title === undefined ? {} : { title: artifact.title }),
                    ...(artifact?.contentType === undefined
                      ? {}
                      : { contentType: artifact.contentType }),
                  });
                }
              : undefined
          }
          workflowRun={workflowRun}
          workflowDraft={context.workflowDraftByToolCallId?.get(row.toolCallId)}
        />
      </div>
    </RowShell>
  );
});

const SubagentRowView = memo(function SubagentRowView({ row }: { row: SubagentRow }) {
  // The subagent line has been paired with the Agent/Task tool line for rendering; the naked line only retains the exception summary.
  // Avoid generating a second "sub-session" card or a second set of drill-down entries.
  const summary = (
    <>
      {row.subagentType} · {row.status}
      {row.summaryText ? ` — ${row.summaryText}` : ""}
    </>
  );
  return (
    <RowShell rowId={row.rowId}>
      <div className="text-ui-sm text-[var(--color-foreground-subtle)]">{summary}</div>
    </RowShell>
  );
});

/**
 * v4 row render dispatch. memo: the virtual list renders row by row, so when the parent projection
 * changes only the rows whose props actually changed re-render (which requires
 * onFork/onRetry/onEdit to be stable references plus a stable context reference; see SessionPane's
 * useCallback/useMemo).
 */
function ConversationRowViewImpl({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  editWorkspaceRewindAvailability,
  hideAssistantActions,
  deferAssistantActions,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  reasoningContentVariant,
  userInputStatus,
}: ConversationRowViewProps) {
  switch (row.kind) {
    case "userInput":
      return (
        <UserInputRowView
          row={row}
          context={context}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          status={userInputStatus}
        />
      );
    case "assistantText":
      return (
        <AssistantTextRowView
          row={row}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          hideActions={hideAssistantActions}
          deferActions={deferAssistantActions}
          copyText={assistantCopyText}
          previewCards={assistantPreviewCards}
          previewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          codeCommentCards={assistantCodeCommentCards}
          codeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      );
    case "reasoning":
      // Turning off "Show Thought Process" only hides each subsequent round of reasoning; the first reasoning
      // It is the minimum necessary thinking prompt for this round, and the rowId derived from the total order of turn must be retained.
      return isConversationReasoningRowVisible(row.rowId, context) ? (
        <ReasoningRowView row={row} contentVariant={reasoningContentVariant} />
      ) : null;
    case "turnHeader":
      return <TurnHeaderRowView row={row} />;
    case "timelineMarker":
      return <TimelineMarkerRowView row={row} context={context} />;
    case "toolCall":
      // Returning null only within a ToolCallBlock leaves an empty RowShell and excess spacing;
      // Cut according to the same tool identity rule at the line distribution point, and no Todo DOM will be generated when the setting is turned off.
      if (
        context.messageStreamShowTodos !== true &&
        resolveToolCallIdentity({ toolName: row.toolName, kind: row.toolName }).family === "todo"
      ) {
        return null;
      }
      return <ToolCallRowView row={row} context={context} />;
    case "subagent":
      return <SubagentRowView row={row} />;
    case "artifact":
      return <ArtifactRowView row={row} />;
    default:
      return null;
  }
}

export const ConversationRowView = memo(ConversationRowViewImpl);
