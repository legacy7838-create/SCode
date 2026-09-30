import { GiftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  CodingPlanQuotaResetDialog,
  formatCodingPlanQuotaResetCountdown,
  type CodingPlanQuotaResetDialogConfig,
} from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type { CodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";

function getRemainingSeconds(expiresAt: number | null): number {
  if (expiresAt == null) {
    return 0;
  }
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
}

export function CodingPlanQuotaResetOpportunity({
  count,
  dialog,
  dialogOpen,
  expiresAt,
  onDialogOpenChange,
  placement = "tooltip",
  visible,
}: {
  count: number;
  dialog?: CodingPlanQuotaResetDialogConfig;
  dialogOpen?: boolean;
  expiresAt: number | null;
  onDialogOpenChange?: (open: boolean) => void;
  placement?: "inline" | "tooltip";
  visible: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [remainingSeconds, setRemainingSeconds] = useState(() => getRemainingSeconds(expiresAt));
  const [uncontrolledDialogOpen, setUncontrolledDialogOpen] = useState(false);
  const resolvedDialogOpen = dialogOpen ?? uncontrolledDialogOpen;
  const setDialogOpen = onDialogOpenChange ?? setUncontrolledDialogOpen;
  // The pop-up box is permanently mounted in the dialog branch, and the Dialog in the successful animation will not be unloaded in advance when the number of opportunities drops from many to single/zero;
  // Only the copywriting and countdown form are decided here: multiple opportunities will display "Get N times", and single opportunity will retain the original copywriting + countdown.
  const hasMultipleOpportunities = count > 1;

  useEffect(() => {
    setRemainingSeconds(getRemainingSeconds(expiresAt));
    if (!visible || hasMultipleOpportunities) {
      return;
    }
    const timer = window.setInterval(() => {
      setRemainingSeconds(getRemainingSeconds(expiresAt));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt, hasMultipleOpportunities, visible]);

  const opportunityLabel = intl.formatMessage(
    { id: "codingPlan.quotaReset.opportunity" },
    { count },
  );
  const countdownLabel = intl.formatMessage(
    { id: "codingPlan.quotaReset.expiresIn" },
    { time: formatCodingPlanQuotaResetCountdown(remainingSeconds, intl.formatMessage) },
  );
  // The multi-opportunity entrance reuses fixed copy without parameters, and users cannot directly confirm the current available times.
  // Here, the visible copy and aria-label share the same dynamic result to avoid another inconsistency between visual and accessibility names.
  const openDialogLabel = intl.formatMessage({ id: "codingPlan.quotaReset.openDialog" }, { count });
  const label = hasMultipleOpportunities ? openDialogLabel : opportunityLabel;
  // The logo does not collapse while the pop-up frame is alive: When the stand-alone opportunity expires after the pop-up frame is opened, the entrance cannot collapse from the button position.
  const effectiveVisible =
    visible && (hasMultipleOpportunities || resolvedDialogOpen || remainingSeconds > 0);
  const commonClassName = [
    "inline-flex h-5 shrink-0 items-center overflow-hidden whitespace-nowrap rounded-full bg-interaction-confirmation-surface px-1.5 text-ui-sm font-medium text-interaction-confirmation-foreground",
    "transition-[max-width,opacity,padding,background-color] duration-200 motion-reduce:transition-none",
    effectiveVisible ? "max-w-64 opacity-100" : "pointer-events-none max-w-0 px-0 opacity-0",
  ].join(" ");
  const badgeBody = (
    <>
      <span className="inline-flex min-w-0 items-center gap-1">
        <GiftIcon className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
      {placement === "inline" && !hasMultipleOpportunities ? (
        <span className="ml-2 shrink-0 font-normal text-interaction-confirmation-foreground/80 tabular-nums">
          {countdownLabel}
        </span>
      ) : null}
    </>
  );

  if (dialog) {
    // You can also click on the reset pop-up box for a single opportunity; the copy and countdown remain in the form of a single opportunity, and can only be upgraded to buttons for interaction.
    const button = (
      <button
        type="button"
        aria-label={label}
        aria-hidden={!effectiveVisible}
        className={`${commonClassName} hover:bg-interaction-confirmation-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}
        data-reset-opportunity="true"
        tabIndex={effectiveVisible ? 0 : -1}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (effectiveVisible) setDialogOpen(true);
        }}
      >
        {badgeBody}
      </button>
    );
    return (
      <>
        {placement === "tooltip" && !hasMultipleOpportunities ? (
          <ControlHintTooltip title={countdownLabel}>{button}</ControlHintTooltip>
        ) : (
          button
        )}
        <CodingPlanQuotaResetDialog
          config={dialog}
          open={resolvedDialogOpen}
          onOpenChange={setDialogOpen}
        />
      </>
    );
  }

  const content = (
    <span aria-hidden={!effectiveVisible} data-reset-opportunity="true" className={commonClassName}>
      {badgeBody}
    </span>
  );

  if (placement === "inline") {
    return content;
  }

  return <ControlHintTooltip title={countdownLabel}>{content}</ControlHintTooltip>;
}
