// ============================================================
// The line that sets the wheel
// ============================================================
// A change to "Configuration" left a control wheel in the transcript: there is no user bubble, its rendering is the card of the new run, and the line above the card says
// What has been changed - the single-line style of the toolbar: slider icon, "Adjusted settings", a period and time for each change, separated by `·`.
// It's a record, not a control.

import { Fragment } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workflowSettingsChangeSegments } from "./workflowSettingsChange.js";

export function WorkflowSettingsChangeRow({
  amend,
  at,
  providerName,
}: {
  amend: WorkflowSettingsAmendMeta;
  /** Sets the moment of the wheel; absence means no writing. */
  at?: number;
  /** providerId → providerName (same lookup as the model segment on the card); absent returns bare modelId. */
  providerName?: (providerId: string) => string | undefined;
}) {
  const { intl } = useZCodeIntl();
  const segments = workflowSettingsChangeSegments(amend, {
    formatMessage: intl.formatMessage.bind(intl),
    ...(providerName === undefined ? {} : { providerName }),
  });
  const time =
    at === undefined
      ? undefined
      : new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(at);
  const parts = [
    intl.formatMessage({ id: "chat.toolCall.workflow.settingsChange.kind" }),
    ...segments,
    ...(time === undefined ? [] : [time]),
  ];
  return (
    <div
      className="flex min-w-0 items-center gap-2 py-0.5 text-ui-base text-foreground-subtle"
      data-testid="workflow-settings-change-row"
    >
      <SlidersHorizontalIcon aria-hidden className="size-4 shrink-0" />
      <span className="flex min-w-0 flex-wrap items-center gap-x-2">
        {parts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <span aria-hidden className="text-foreground-subtlest">
                ·
              </span>
            ) : null}
            <span
              className={
                index === 0
                  ? "font-medium"
                  : index === parts.length - 1 && time !== undefined
                    ? "text-foreground-subtlest tabular-nums"
                    : undefined
              }
            >
              {part}
            </span>
          </Fragment>
        ))}
      </span>
    </div>
  );
}
