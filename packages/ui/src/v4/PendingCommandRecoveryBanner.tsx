import { memo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";

interface PendingCommandRecoveryBannerProps {
  entry: PendingCommandEntry;
  onResend?: () => void;
  onDismiss: () => void;
}

/**
 * startNow inputs that were explicitly dropped by a restart only get an explicit user decision —
 * the component itself never replays them automatically.
 */
export const PendingCommandRecoveryBanner = memo(function PendingCommandRecoveryBanner({
  entry,
  onResend,
  onDismiss,
}: PendingCommandRecoveryBannerProps) {
  const { intl } = useZCodeIntl();
  const hasReplayPayload = entry.replay.kind === "input";
  // Root cause: The recovery prompt used to use a whole block of warning yellow, and the same bottom dock ordinary error
  // A wrong visual hierarchy is formed. The default surface/border/foreground of ChatErrorBanner is reused here.
  return (
    <div
      role="status"
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">
        {intl.formatMessage({ id: "chat.pendingCommand.discarded" })}
      </p>
      {hasReplayPayload && onResend ? (
        <button
          type="button"
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
          onClick={onResend}
        >
          {intl.formatMessage({ id: "chat.pendingCommand.resend" })}
        </button>
      ) : null}
      <button
        type="button"
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
        onClick={onDismiss}
      >
        {intl.formatMessage({ id: "chat.pendingCommand.dismiss" })}
      </button>
    </div>
  );
});
