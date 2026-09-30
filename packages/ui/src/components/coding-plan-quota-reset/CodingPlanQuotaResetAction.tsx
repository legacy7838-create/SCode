import { CheckIcon, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CodingPlanResetType } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { burstCodingPlanQuotaResetConfetti } from "@/lib/codingPlanQuotaResetConfetti.js";

const MANUAL_RESET_SUCCESS_DISPLAY_MS = 600;

type CodingPlanQuotaResetActionBehavior =
  | { onOpenDialog: () => void; onReset?: never }
  | { onOpenDialog?: never; onReset: () => Promise<void> };

export function LocalizedCodingPlanQuotaResetAction({
  completedAt,
  processing,
  onOpenDialog,
  onReset,
  autoCelebrateCompletedAt,
  onAutoCelebrated,
  resetType = "FIVE_HOUR",
}: {
  completedAt: number | null;
  processing: boolean;
  /** The used_at used by the Composer trigger to require reseeding of flowers after hovering to expand the panel when automatic/operation is completed; manually reset to null. */
  autoCelebrateCompletedAt?: number | null;
  onAutoCelebrated?: (completedAt: number) => void;
  /** Five hours and weekly quota share the same button component, only accessibility/processing copywriting is distinguished by type. */
  resetType?: CodingPlanResetType;
} & CodingPlanQuotaResetActionBehavior) {
  const { intl, locale } = useZCodeIntl();
  const completedTime = completedAt
    ? new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(completedAt)
    : null;

  return (
    <CodingPlanQuotaResetAction
      ariaLabel={intl.formatMessage({
        id:
          resetType === "WEEK"
            ? "codingPlan.quotaReset.resetAriaWeek"
            : "codingPlan.quotaReset.resetAria",
      })}
      autoCelebrateCompletedAt={autoCelebrateCompletedAt}
      completedAt={completedAt}
      completedLabel={intl.formatMessage({
        id: "codingPlan.quotaReset.completed",
      })}
      completedTooltipLabel={
        completedTime
          ? intl.formatMessage({ id: "codingPlan.quotaReset.completedAt" }, { time: completedTime })
          : undefined
      }
      processing={processing}
      processingLabel={intl.formatMessage({
        id:
          resetType === "WEEK"
            ? "codingPlan.quotaReset.processingWeek"
            : "codingPlan.quotaReset.processing",
      })}
      resetLabel={intl.formatMessage({ id: "codingPlan.quotaReset.reset" })}
      successLabel={intl.formatMessage({ id: "codingPlan.quotaReset.success" })}
      onAutoCelebrated={onAutoCelebrated}
      {...(onOpenDialog ? { onOpenDialog } : { onReset: onReset! })}
    />
  );
}

export function CodingPlanQuotaResetAction({
  ariaLabel,
  autoCelebrateCompletedAt,
  completedAt,
  completedLabel,
  completedTooltipLabel,
  processing,
  processingLabel,
  resetLabel,
  successLabel,
  onAutoCelebrated,
  onOpenDialog,
  onReset,
  onCelebrate = burstCodingPlanQuotaResetConfetti,
}: {
  ariaLabel: string;
  autoCelebrateCompletedAt?: number | null;
  completedAt: number | null;
  completedLabel: string;
  completedTooltipLabel?: string;
  processing: boolean;
  processingLabel: string;
  resetLabel: string;
  successLabel: string;
  onAutoCelebrated?: (completedAt: number) => void;
  onCelebrate?: (origin: HTMLElement) => void;
} & CodingPlanQuotaResetActionBehavior) {
  const [localProcessing, setLocalProcessing] = useState(false);
  const [successCompletedAt, setSuccessCompletedAt] = useState<number | null>(null);
  const previousCompletedAtRef = useRef(completedAt);
  const clickedOriginRef = useRef<HTMLElement | null>(null);
  const awaitingOwnCompletionRef = useRef(false);
  // "Reset" copy element when automatic/operation is completed, used to resow flowers from the same position as manual reset.
  const completedTextRef = useRef<HTMLSpanElement | null>(null);
  const autoCelebratedCompletedAtRef = useRef<number | null>(null);
  const effectiveProcessing = processing || localProcessing;

  useEffect(() => {
    const previousCompletedAt = previousCompletedAtRef.current;
    previousCompletedAtRef.current = completedAt;
    if (
      completedAt === null ||
      completedAt === previousCompletedAt ||
      !awaitingOwnCompletionRef.current
    ) {
      return;
    }

    // The success animation can only be driven by the server-side used_at and cannot be optimistically forged using Date.now() when clicking.
    awaitingOwnCompletionRef.current = false;
    setSuccessCompletedAt(completedAt);
    if (clickedOriginRef.current) {
      onCelebrate(clickedOriginRef.current);
    }
  }, [completedAt, onCelebrate]);

  // Automatic/operational reset: After the user hover trigger expands the panel (Composer passes in autoCelebrateCompletedAt),
  // Re-sow the flowers from the "reset" copy position. Manual reset is performed by clicking on the branch above to scatter flowers, which will not hit (not arm).
  useEffect(() => {
    if (
      autoCelebrateCompletedAt == null ||
      completedAt === null ||
      autoCelebrateCompletedAt !== completedAt ||
      autoCelebratedCompletedAtRef.current === completedAt
    ) {
      return;
    }

    // Arm cannot be consumed immediately when the floating layer has just submitted the DOM: the animation may finish playing before the panel has completed mounting/positioning.
    // Delaying one frame confirms that the anchor point is still connected to the document, and only marks it as played after the sprinkle is actually called; closing the floating layer will cancel the frame.
    const frameId = window.requestAnimationFrame(() => {
      const origin = completedTextRef.current;
      if (!origin?.isConnected) {
        return;
      }
      onCelebrate(origin);
      autoCelebratedCompletedAtRef.current = completedAt;
      onAutoCelebrated?.(completedAt);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [autoCelebrateCompletedAt, completedAt, onAutoCelebrated, onCelebrate]);

  useEffect(() => {
    if (successCompletedAt === null) {
      return;
    }
    const timer = window.setTimeout(
      () => setSuccessCompletedAt(null),
      MANUAL_RESET_SUCCESS_DISPLAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [successCompletedAt]);

  const awaitingSuccessRender = Boolean(
    completedAt !== null &&
    awaitingOwnCompletionRef.current &&
    completedAt !== previousCompletedAtRef.current,
  );
  const showSuccess =
    completedAt !== null && (successCompletedAt === completedAt || awaitingSuccessRender);

  if (showSuccess) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={successLabel}
        disabled
        className="rounded-md px-1 text-ui-sm text-success hover:text-success"
      >
        <CheckIcon
          className="size-3 animate-in zoom-in-75 motion-reduce:animate-none"
          aria-hidden="true"
        />
      </Button>
    );
  }

  if (completedAt !== null) {
    const completedText = (
      <span
        ref={completedTextRef}
        // min-h is consistent with the xs size (h-5) of the "Reset" button: the three states are of equal height to avoid the completion state.
        // The label row of the quota bar is raised, causing the values ​​of other quota bars in the same row to be misaligned with the progress bar.
        className="inline-flex min-h-5 items-center text-ui-xs text-foreground-subtlest tabular-nums"
        tabIndex={completedTooltipLabel ? 0 : undefined}
      >
        {completedLabel}
      </span>
    );

    return completedTooltipLabel ? (
      <ControlHintTooltip title={completedTooltipLabel}>{completedText}</ControlHintTooltip>
    ) : (
      completedText
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={effectiveProcessing ? processingLabel : ariaLabel}
      disabled={effectiveProcessing}
      className="rounded-md bg-interaction-confirmation-surface px-1 text-ui-sm text-interaction-confirmation-foreground hover:bg-interaction-confirmation-surface hover:text-interaction-confirmation-foreground"
      onClick={(event) => {
        if (effectiveProcessing || completedAt) {
          return;
        }
        // The entry next to the page's quota title is only responsible for opening a unified pop-up window; it does not enter processing in advance, nor does it directly write off opportunities.
        if (onOpenDialog) {
          onOpenDialog();
          return;
        }
        clickedOriginRef.current = event.currentTarget;
        awaitingOwnCompletionRef.current = true;
        setLocalProcessing(true);
        void onReset()
          .catch(() => {
            // Failed copywriting is toasted by joint debugging hook; Action is only responsible for restoring the interaction and does not play the success animation.
            awaitingOwnCompletionRef.current = false;
          })
          .finally(() => {
            setLocalProcessing(false);
          });
      }}
    >
      {effectiveProcessing ? (
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        resetLabel
      )}
    </Button>
  );
}
