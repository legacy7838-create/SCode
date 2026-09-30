// ============================================================
// The ins and outs of the details page
// ============================================================
// Detach (max-lines gate) from WorkflowRunSidePaneSections.tsx. Two kinds of runs have this part: the one started directly by the center
// Revised with "Configuration".
// There is no run initiated by the tool path - its origin is the CreateWorkflow line in the transcription. Read only, no action.

import { Fragment, memo } from "react";
import type { WorkflowLaunchMeta } from "@zcode/shared/zcode-protocol-v4";
import { workflowSettingsProvenanceRows } from "@/components/workflow-timeline/workflowSettingsChange.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Argument value: strings as-is, everything else through `JSON.stringify` (the same normalization
 * the argument pane / notifications use).
 */
function formatArgValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Hub start: “Started by you from the workflow hub · time” plus the scope badge, with the
 * description and the argument key/value table below it. “Configure” revision: “Settings adjusted
 * by you · time”, no scope badge, and one `{from} → {to}` line per change below it.
 */
export const WorkflowRunProvenance = memo(function WorkflowRunProvenance({
  meta,
  providerName,
  startedAt,
}: {
  meta: WorkflowLaunchMeta;
  /**
   * providerId → provider name (the same lookup as the model segment of the summary line); when
   * absent, falls back to the bare modelId.
   */
  providerName?: (providerId: string) => string | undefined;
  /** The startedAt of the start round / the settings round; when absent no timestamp is written. */
  startedAt?: number;
}) {
  const { intl } = useZCodeIntl();
  const amend = meta.amend;
  const caption = intl.formatMessage({
    id:
      amend === undefined
        ? "chat.workflowLaunch.startedByYou"
        : "chat.workflowLaunch.settingsChangedByYou",
  });
  const time =
    startedAt === undefined
      ? undefined
      : new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(startedAt);
  const rows =
    amend === undefined
      ? Object.entries(meta.args ?? {}).map(([key, value]) => ({
          key,
          label: key,
          value: formatArgValue(value),
        }))
      : workflowSettingsProvenanceRows(amend, {
          formatMessage: intl.formatMessage.bind(intl),
          ...(providerName === undefined ? {} : { providerName }),
        });

  return (
    <div
      className="shrink-0 border-b border-border px-4 py-3"
      data-testid="workflow-run-provenance"
      data-workflow-launch-kind={amend === undefined ? "launch" : "settings"}
      {...(meta.scope === undefined ? {} : { "data-workflow-launch-scope": meta.scope })}
    >
      <div className="flex min-w-0 items-center gap-2 text-ui-xs text-foreground-subtle">
        <span className="min-w-0 truncate">
          {time === undefined ? caption : `${caption} · ${time}`}
        </span>
        {/* Scope badge: reuses the hub's small badge class (rounded-sm border, small type). The settings round saves no file, so there is no scope. */}
        {amend !== undefined || meta.scope === undefined ? null : (
          <span
            className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 leading-none text-foreground-subtlest"
            data-testid="workflow-run-provenance-scope"
          >
            {intl.formatMessage({ id: `chat.workflowLaunch.scope.${meta.scope}` })}
          </span>
        )}
      </div>
      {amend === undefined && meta.description ? (
        <p className="mt-1 min-w-0 text-ui-sm leading-5 text-foreground-subtle">
          {meta.description}
        </p>
      ) : null}
      {/*
          Key/value table: arguments get a mono key and a mono value truncated to a single line
          (title carries the full text); setting changes get human-readable labels, values likewise
          on one line. The side panel has vertical room to spare, so nothing is collapsed.
          */}
      {rows.length > 0 ? (
        <dl
          className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"
          data-testid={
            amend === undefined
              ? "workflow-run-provenance-args"
              : "workflow-run-provenance-settings"
          }
        >
          {rows.map((row) => (
            <Fragment key={row.key}>
              <dt
                className={
                  amend === undefined
                    ? "truncate font-mono text-ui-xs text-foreground-subtle"
                    : "truncate text-ui-xs text-foreground-subtle"
                }
              >
                {row.label}
              </dt>
              <dd
                className={
                  amend === undefined
                    ? "truncate font-mono text-ui-xs text-foreground"
                    : "truncate text-ui-xs text-foreground tabular-nums"
                }
                title={row.value}
              >
                {row.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
});
